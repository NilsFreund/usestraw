import { formatHost } from "../message/fields/host"
import { withReceived } from "../message/fields/via"
import { MAX_MESSAGE_SIZE } from "../message/limits"
import { parseMessage } from "../message/parse"
import { serializeMessage } from "../message/serialize"
import { show } from "../message/syntax"
import { isRequest, type SipRequest, type SipResponse } from "../message/types"
import { isIp } from "../support/ip"
import { checkTime, earliest } from "../support/time"
import { resolveTimers } from "../transaction/timers"
import { createTransactions } from "../transaction/transactions"
import type { TransactionEvent, TransactionOutput } from "../transaction/types"
import type { TransportAddress } from "../transport/address"
import { createAdmission } from "./admission"
import { createTrust } from "./authenticator"
import { createCalls } from "./calls/calls"
import type { MediaSetup } from "./calls/media"
import type { CallOutput } from "./calls/types"
import {
  checkAddress,
  checkAor,
  checkAppMedia,
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
  MAX_CALLS,
  parseAcceptFrom,
} from "./checks"
import { emit, send } from "./outputs"
import { createOutside } from "./outside"
import { defaultRegistrar, dialogContact } from "./registration/binding"
import { createRegistration } from "./registration/registration"
import type { RegistrationInput, RegistrationOutput } from "./registration/types"
import { createOptionsRequest } from "./requests"
import { createResponder } from "./responder"
import type {
  AppMedia,
  Core,
  CoreCommand,
  CoreInput,
  CoreOptions,
  CoreOutput,
  LocalMedia,
} from "./types"

// Output too big for any parser, or aimed at port 0, is dropped like a lost packet
const fits = (output: CoreOutput) =>
  output.type !== "send" || (output.data.length <= MAX_MESSAGE_SIZE && output.to.port > 0)

/**
 * Creates a sans-I/O SIP user agent with registration, calls, SDP offer/answer and digest auth.
 * The same inputs and random draws always give the same outputs.
 *
 * @example
 * ```ts
 * const core = createCore({ address, aor: "sip:alice@example.com", random })
 * function run(input: CoreInput) {
 *   for (const output of core.handle(input, performance.now())) {
 *     if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
 *     else console.log(output.event)
 *   }
 * }
 * run({ type: "command", command: { type: "register", to: server } })
 * ```
 * @throws {TypeError} for an invalid address, address of record, credentials, `acceptFrom` or `media`
 * @throws {RangeError} for timers, `maxCalls` or lengths out of range
 * @experimental `usestraw/core` may change in minor versions while the browser softphone takes shape.
 */
export function createCore(options: CoreOptions): Core {
  const { aor, random, maxCalls = MAX_CALLS, acceptFrom, media: making = "rtp" } = options
  let { address } = options
  checkAddress(address)
  checkAor(aor)
  const credentials = options.credentials && Object.freeze({ ...options.credentials })
  if (credentials) checkCredentials(credentials)
  checkMaxCalls(maxCalls)
  if (making !== "rtp" && making !== "sdp") {
    throw new TypeError(`media must be "rtp" or "sdp", got ${show(making)}`)
  }
  const appMedia = making === "sdp"
  const accepted = acceptFrom === undefined ? undefined : parseAcceptFrom(acceptFrom)
  const timers = resolveTimers(options.timers)
  const transactions = createTransactions({ local: address, timers })
  const identity = {
    get address() {
      return address
    },
    aor,
    random,
  }
  const responder = createResponder(random)
  const trust = createTrust()
  const registration = createRegistration(identity, trust, credentials)
  const calls = createCalls({
    identity,
    get contact() {
      return dialogContact(registration.contact, address)
    },
    credentials,
    trust,
    timers,
    appMedia,
  })
  const { accepts, admit } = createAdmission({
    accepted,
    maxCalls,
    calls,
    transactions,
    appMedia,
  })
  const outside = createOutside()

  function handle(input: CoreInput, now: number): CoreOutput[] {
    checkTime(now)
    return run(input, now).filter(fits)
  }

  function run(input: CoreInput, now: number): CoreOutput[] {
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

  function receive(data: Uint8Array, from: TransportAddress, now: number): CoreOutput[] {
    checkSource(from)
    const result = parseMessage(data)
    if (!result.ok) return [emit({ type: "invalid", error: result.error, from })]
    const { message } = result
    if (!isRequest(message)) return translate(transactions.receive(message, from, now), now)
    if (!accepts(message, from)) {
      const error = `${message.method} from ${formatHost(from.host)}, not an accepted host`
      return [emit({ type: "invalid", error, from })]
    }
    const via = message.via.map((entry, index) =>
      index === 0 && isIp(from.host) ? withReceived(entry, from.host, from.port) : entry,
    )
    const request = { ...message, via }
    const refusal = request.method === "INVITE" ? admit(request) : undefined
    if (refusal) return responder.respond(request, from, refusal)
    if (!isForCalls(request)) return responder.respond(request, from)
    return translate(transactions.receive(request, from, now), now)
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

  function execute(command: CoreCommand, now: number): CoreOutput[] {
    switch (command.type) {
      case "send":
        checkAddress(command.to)
        return [{ type: "send", data: serializeMessage(command.message), to: command.to }]
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
      case "move":
        checkAddress(command.address)
        if (command.address.host !== address.host) outside.forget()
        address = command.address
        transactions.move(address)
        registration.move(address)
        return []
      case "call": {
        const { call, uri, to } = command
        checkCallId(call)
        checkRequestUri(uri)
        checkAddress(to)
        const media = mediaOf(command.media)
        if (calls.owns(call)) throw new TypeError(`Call ${show(call)} already exists`)
        return translateCalls(calls.start({ call, uri, to, media }, now), now)
      }
      case "accept": {
        checkCall(command.call)
        return translateCalls(calls.accept(command.call, mediaOf(command.media), now), now)
      }
      case "answer": {
        checkCall(command.call)
        if (!appMedia) throw new TypeError('answer needs a core with media: "sdp"')
        const sdp = checkAppMedia(command.media)
        return translateCalls(calls.answer(command.call, sdp, now), now)
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

  function mediaOf(media: LocalMedia | AppMedia): MediaSetup {
    if (appMedia) return { sdp: checkAppMedia(media) }
    return outside.advertised(checkMedia(media, address.host))
  }

  // Answers from the server show where it saw us, which audio and a trunk's Contact need
  function learn(response: SipResponse): void {
    const { method } = response.cseq
    if (method === "REGISTER" || method === "OPTIONS") {
      outside.learn(response, address)
    }
    if (method === "OPTIONS") registration.observe(response)
  }

  function translate(outputs: TransactionOutput[], now: number): CoreOutput[] {
    return outputs.flatMap((output) => {
      if (output.type === "send") return [send(output.message, output.to)]
      const happened = output.event
      if (happened.type === "response") learn(happened.response)
      if (isRegistration(happened)) {
        return translateRegistration(registration.receive(happened, now), now)
      }
      const handled = forCalls(happened, now)
      return handled ? translateCalls(handled, now) : [emit(happened)]
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
      return calls.ring({ invite: request, transaction, from }, now)
    }
    return calls.request(request, transaction, now)
  }

  function translateCalls(outputs: CallOutput[], now: number): CoreOutput[] {
    return outputs.flatMap((output) => {
      if (output.type === "event") return [emit(output.event)]
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

  function translateRegistration(outputs: RegistrationOutput[], now: number): CoreOutput[] {
    return outputs.flatMap((output) =>
      output.type === "send"
        ? translate(transactions.send(output.request, output.to, now), now)
        : [emit(output.event)],
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
