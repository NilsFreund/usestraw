import { isUri } from "../message/fields/uri"
import { withReceived } from "../message/fields/via"
import { parseMessage } from "../message/parse"
import { show } from "../message/syntax"
import { isRequest } from "../message/types"
import { checkTime, earliest } from "../support/time"
import { defaultTimers, type TimerSettings } from "../transaction/timers"
import { createTransactions } from "../transaction/transactions"
import type { TransactionEvent, TransactionOutput } from "../transaction/types"
import type { Address } from "../transport/address"
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
import { defaultRegistrar } from "./registration/binding"
import { createRegistration } from "./registration/registration"
import type { RegistrationInput, RegistrationOutput } from "./registration/types"
import { createOptionsRequest } from "./requests"
import { createResponder } from "./responder"
import type { Command, Credentials, Input, Output, Random } from "./types"

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

  function handle(input: Input, now: number): Output[] {
    checkTime(now)
    switch (input.type) {
      case "receive":
        return receive(input.data, input.from, now)
      case "timeout":
        return [
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
    return responder.respond({ ...message, via }, from)
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
      default:
        throw new TypeError(`Unknown command ${show(command)}`)
    }
  }

  function translate(outputs: TransactionOutput[], now: number): Output[] {
    return outputs.flatMap((output) => {
      if (output.type === "send") return [send(output.message, output.to)]
      const happened = output.event
      return isRegistration(happened)
        ? translateRegistration(registration.receive(happened, now), now)
        : [event(happened)]
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
    return earliest([transactions.nextDeadline(), registration.nextDeadline()])
  }

  return { handle, nextDeadline }
}

function isRegistration(happened: TransactionEvent): happened is RegistrationInput {
  if (happened.type === "response") return happened.response.cseq.method === "REGISTER"
  return happened.type === "timeout" && happened.request.method === "REGISTER"
}
