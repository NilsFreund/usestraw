import { isUri } from "../message/fields/uri"
import { withReceived } from "../message/fields/via"
import { parseMessage } from "../message/parse"
import { show } from "../message/syntax"
import { isRequest, type SipRequest } from "../message/types"
import { isPlayable } from "../sdp/negotiate"
import { checkTime, earliest } from "../support/time"
import { defaultTimers, type TimerSettings } from "../transaction/timers"
import { createTransactions } from "../transaction/transactions"
import type { TransactionEvent, TransactionOutput } from "../transaction/types"
import type { Address } from "../transport/address"
import { createCalls } from "./calls/calls"
import { INCOMPATIBLE_MEDIA } from "./calls/replies"
import type { CallOutput } from "./calls/types"
import {
  checkAddress,
  checkCall,
  checkCallId,
  checkCredentials,
  checkExpires,
  checkMaxCalls,
  checkMedia,
  checkRegistrar,
  checkRejection,
  checkRequestUri,
  checkSource,
} from "./checks"
import { event, send } from "./outputs"
import { createContact, defaultRegistrar } from "./registration/binding"
import { createRegistration } from "./registration/registration"
import type { RegistrationInput, RegistrationOutput } from "./registration/types"
import { createOptionsRequest } from "./requests"
import { createResponder } from "./responder"
import type { Command, Credentials, Input, Output, Random } from "./types"
import { type Answer, answerWith, checkInvite } from "./uas"

const LOOP: Answer = answerWith(482, "Loop Detected")
const BUSY: Answer = answerWith(486, "Busy Here")
const INCOMPATIBLE: Answer = answerWith(488, "Not Acceptable Here", [INCOMPATIBLE_MEDIA])
const FULL: Answer = answerWith(503, "Service Unavailable", [{ name: "Retry-After", value: "5" }])

/** Options for {@link createCore}. */
export interface CoreOptions {
  /** Where this phone receives SIP, as the far end sees it. */
  readonly address: Address
  /** The address of record, e.g. `"sip:alice@example.com"`. */
  readonly aor: string
  /** Source of tags, branches and nonces. Must be cryptographically secure. */
  readonly random: Random
  readonly credentials?: Credentials
  /** RFC 3261 timers, for tests and unusual networks. Defaults to {@link defaultTimers}. */
  readonly timers?: TimerSettings
  /** Turns incoming calls away as busy (486) while this many calls run. Defaults to 100. */
  readonly maxCalls?: number
}

/**
 * SIP as a pure state machine, with no sockets or clocks. Pass every input with the current time,
 * do what it returns, and send a `timeout` input once `nextDeadline()` has passed.
 */
export interface Core {
  /** Runs one input at time `now` (milliseconds, any monotonic clock) and returns what to do. */
  handle(input: Input, now: number): Output[]
  /** When the core next wants a `timeout` input, on the clock of `now`; `undefined` if never. */
  nextDeadline(): number | undefined
}

/**
 * Creates a sans-I/O SIP user agent with registration, calls, SDP offer/answer and digest auth.
 * The same inputs and random draws always give the same outputs.
 *
 * @example
 * ```ts
 * const core = createCore({ address, aor: "sip:alice@example.com", random })
 * function run(input: Input) {
 *   for (const output of core.handle(input, performance.now())) {
 *     if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
 *     else console.log(output.event)
 *   }
 * }
 * run({ type: "command", command: { type: "register", to: server } })
 * ```
 * @throws {TypeError} for an invalid address, address of record or credentials
 */
export function createCore(options: CoreOptions): Core {
  const { address, aor, random, maxCalls = 100 } = options
  checkAddress(address)
  if (!isUri(aor)) throw new TypeError(`Invalid address of record ${show(aor)}`)
  const credentials = options.credentials && Object.freeze({ ...options.credentials })
  if (credentials) checkCredentials(credentials)
  checkMaxCalls(maxCalls)
  // Ended calls linger for 64·T1, so a flood of short calls is capped before it costs memory
  const capacity = Math.max(64, 4 * maxCalls)
  const timers = options.timers ?? defaultTimers
  const transactions = createTransactions({ local: address, timers })
  const identity = { address, aor, random }
  const responder = createResponder(random)
  const registration = createRegistration(identity, credentials)
  const contact = createContact(address, aor)
  const calls = createCalls({ identity, contact, credentials, timers })

  function handle(input: Input, now: number): Output[] {
    checkTime(now)
    switch (input.type) {
      case "receive":
        return receive(input.data, input.from, now)
      case "timeout":
        return [
          ...translate(transactions.expire(now), now),
          ...translateCalls(calls.expire(now), now),
          ...translateRegistration(registration.expire(now), now),
        ]
      case "command":
        return execute(input.command, now)
      default:
        throw new TypeError(`Unknown input ${show(input)}`)
    }
  }

  function receive(data: Uint8Array, from: Address, now: number): Output[] {
    checkSource(from)
    const result = parseMessage(data)
    if (!result.ok) return [event({ type: "invalid", error: result.error, from })]
    const { message } = result
    if (!isRequest(message)) return translate(transactions.receive(message, from, now), now)
    const via = message.via.map((entry, index) =>
      index === 0 ? withReceived(entry, from.host, from.port) : entry,
    )
    const request = { ...message, via }
    const refusal = request.method === "INVITE" ? admit(request) : undefined
    if (refusal) return responder.respond(request, from, refusal)
    if (!isForCalls(request)) return responder.respond(request, from)
    return translate(transactions.receive(request, from, now), now)
  }

  // RFC 3261 §8.2.2.2: a Call-ID stays taken while its call lives, and its own INVITE coming back is merged
  function admit(invite: SipRequest): Answer | undefined {
    if (invite.to.params.has("tag") || transactions.hasInvite(invite)) return undefined
    const refusal = checkInvite(invite)
    if (refusal) return refusal
    if (invite.body.length > 0 && !isPlayable(invite.body)) return INCOMPATIBLE
    if (calls.collides(invite)) return LOOP
    if (calls.active() >= maxCalls) return BUSY
    return calls.tracked() >= capacity ? FULL : undefined
  }

  function isForCalls(request: SipRequest): boolean {
    switch (request.method) {
      case "INVITE":
        return !request.to.params.has("tag") || calls.matches(request)
      case "ACK":
        return calls.owns(request.callId)
      case "CANCEL":
        return transactions.hasInvite(request)
      case "BYE":
        return calls.matches(request)
      default:
        return false
    }
  }

  function execute(command: Command, now: number): Output[] {
    switch (command.type) {
      case "send":
        checkAddress(command.to)
        return [send(command.message, command.to)]
      case "options": {
        checkAddress(command.to)
        checkRequestUri(command.uri)
        if (command.callId !== undefined) checkCallId(command.callId)
        const request = createOptionsRequest(command.uri, identity, command.callId)
        return translate(transactions.send(request, command.to, now), now)
      }
      case "register": {
        const { to, registrar = defaultRegistrar(aor), expires = 3600 } = command
        checkAddress(to)
        checkRegistrar(registrar)
        checkExpires(expires)
        return translateRegistration(registration.register({ to, registrar, expires }), now)
      }
      case "unregister":
        return translateRegistration(registration.unregister(), now)
      case "call": {
        const { call, uri, to } = command
        checkCallId(call)
        checkRequestUri(uri)
        checkAddress(to)
        const media = checkMedia(command.media, address.host)
        if (calls.owns(call)) throw new Error(`Call ${show(call)} already exists`)
        return translateCalls(calls.start({ call, uri, to, media }, now), now)
      }
      case "accept": {
        checkCall(command.call)
        const media = checkMedia(command.media, address.host)
        return translateCalls(calls.accept(command.call, media, now), now)
      }
      case "end": {
        const { call, status } = command
        checkCall(call)
        if (status !== undefined) checkRejection(status)
        return translateCalls(calls.end(call, now, status), now)
      }
      default:
        throw new TypeError(`Unknown command ${show(command)}`)
    }
  }

  function translate(outputs: TransactionOutput[], now: number): Output[] {
    return outputs.flatMap((output) => {
      if (output.type === "send") return [send(output.message, output.to)]
      const happened = output.event
      if (isRegistration(happened)) {
        return translateRegistration(registration.receive(happened, now), now)
      }
      const handled = forCalls(happened, now)
      return handled ? translateCalls(handled, now) : [event(happened)]
    })
  }

  function forCalls(happened: TransactionEvent, now: number): CallOutput[] | undefined {
    if (happened.type === "response" || isRetransmittedAnswer(happened)) {
      const { response } = happened
      return calls.owns(response.callId) ? calls.response(response, now) : undefined
    }
    if (happened.type === "timeout") {
      const { request } = happened
      return calls.owns(request.callId) ? calls.timeout(request, now) : undefined
    }
    if (happened.type !== "request") return undefined
    const { request, transaction, from } = happened
    if (!transaction) return calls.acknowledge(request, now)
    if (request.method === "INVITE" && !request.to.params.has("tag")) {
      return calls.receive({ invite: request, transaction, from }, now)
    }
    return calls.request(request, transaction, now)
  }

  function translateCalls(outputs: CallOutput[], now: number): Output[] {
    return outputs.flatMap((output) => {
      if (output.type === "event") return [event(output.event)]
      if (output.type === "abandon") {
        transactions.abandon(output.request)
        return []
      }
      const sent =
        output.type === "send"
          ? transactions.send(output.request, output.to, now)
          : transactions.respond(output.transaction, output.response, now)
      return translate(sent, now)
    })
  }

  function translateRegistration(outputs: RegistrationOutput[], now: number): Output[] {
    return outputs.flatMap((output) =>
      output.type === "send"
        ? translate(transactions.send(output.request, output.to, now), now)
        : [event(output.event)],
    )
  }

  function nextDeadline(): number | undefined {
    return earliest([
      transactions.nextDeadline(),
      registration.nextDeadline(),
      calls.nextDeadline(),
    ])
  }

  return { handle, nextDeadline }
}

// A 2xx to an INVITE whose transaction is gone still needs its ACK; every other stray is ignored
function isRetransmittedAnswer(
  happened: TransactionEvent,
): happened is Extract<TransactionEvent, { readonly type: "stray" }> {
  if (happened.type !== "stray") return false
  const { status, cseq } = happened.response
  return cseq.method === "INVITE" && status >= 200 && status < 300
}

function isRegistration(happened: TransactionEvent): happened is RegistrationInput {
  if (happened.type === "response") return happened.response.cseq.method === "REGISTER"
  return happened.type === "timeout" && happened.request.method === "REGISTER"
}
