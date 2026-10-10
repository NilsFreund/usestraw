import { isUri } from "../message/fields/uri"
import { withReceived } from "../message/fields/via"
import { parseMessage } from "../message/parse"
import { show } from "../message/syntax"
import { isRequest } from "../message/types"
import { checkTime, earliest } from "../support/time"
import { defaultTimers, type TimerSettings, transactionTimeout } from "../transaction/timers"
import { createTransactions } from "../transaction/transactions"
import type { TransactionEvent, TransactionOutput } from "../transaction/types"
import type { Address } from "../transport/address"
import { createCalls } from "./calls/calls"
import type { CallOutput } from "./calls/outgoing"
import {
  checkAddress,
  checkCallId,
  checkCredentials,
  checkExpires,
  checkRegistrar,
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

const MAX_SDP = 32 * 1024

export interface CoreOptions {
  readonly address: Address
  readonly aor: string
  readonly random: Random
  readonly credentials?: Credentials
  readonly timers?: TimerSettings
}

export interface Core {
  handle(input: Input, now: number): Output[]
  nextDeadline(): number | undefined
}

export function createCore(options: CoreOptions): Core {
  const { address, aor, random } = options
  checkAddress(address)
  if (!isUri(aor)) throw new TypeError(`Invalid address of record ${show(aor)}`)
  const credentials = options.credentials && Object.freeze({ ...options.credentials })
  if (credentials) checkCredentials(credentials)
  const timers = options.timers ?? defaultTimers
  const transactions = createTransactions({ local: address, timers })
  const identity = { address, aor, random }
  const responder = createResponder(random)
  const registration = createRegistration(identity, credentials)
  const contact = createContact(address, aor)
  const calls = createCalls(identity, contact, credentials, transactionTimeout(timers))

  function handle(input: Input, now: number): Output[] {
    checkTime(now)
    switch (input.type) {
      case "receive":
        return receive(input.data, input.from, now)
      case "timeout":
        return [
          ...translateCalls(calls.expire(now), now),
          ...translate(transactions.expire(now), now),
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
    if (request.method === "BYE" && calls.matches(request)) {
      return translate(transactions.receive(request, from, now), now)
    }
    return responder.respond(request, from)
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
        const { call, uri, to, sdp } = command
        checkCallId(call)
        checkRequestUri(uri)
        checkAddress(to)
        // RFC 3261 §13.2.2.4: without an offer in the INVITE we could never answer one in the ACK
        if (!(sdp instanceof Uint8Array)) throw new TypeError("The SDP offer must be a Uint8Array")
        if (sdp.length > MAX_SDP) {
          throw new RangeError(`The SDP has ${sdp.length} bytes, at most ${MAX_SDP} fit`)
        }
        if (calls.owns(call)) throw new Error(`Call ${show(call)} already exists`)
        return translateCalls(calls.start({ call, uri, to, sdp: new Uint8Array(sdp) }, now), now)
      }
      case "end":
        checkCallId(command.call)
        return translateCalls(calls.end(command.call, now), now)
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
    if (happened.type !== "request" || !happened.transaction) return undefined
    return calls.request(happened.request, happened.transaction, now)
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
