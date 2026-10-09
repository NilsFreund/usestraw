import { isRequestUri, isUri } from "../message/fields/uri"
import { withReceived } from "../message/fields/via"
import { parseMessage } from "../message/parse"
import { createResponse } from "../message/response"
import { serializeMessage } from "../message/serialize"
import { isRequest, type SipMessage, type SipRequest } from "../message/types"
import { defaultTimers, type TimerSettings } from "../transaction/timers"
import { createTransactions } from "../transaction/transactions"
import type { TransactionEvent, TransactionOutput } from "../transaction/types"
import type { Address } from "../transport/address"
import { createTag } from "./ids"
import { createOptionsRequest } from "./requests"
import type { Command, CoreEvent, Input, Output, Random } from "./types"
import { answer } from "./uas"

export interface CoreOptions {
  readonly address: Address
  readonly aor: string
  readonly random: Random
  readonly timers?: TimerSettings
}

export interface Core {
  handle(input: Input, now: number): Output[]
  nextDeadline(): number | undefined
}

export function createCore(options: CoreOptions): Core {
  const { address, aor, random } = options
  if (!isUri(aor)) throw new TypeError(`Invalid address of record "${aor}"`)
  const timers = options.timers ?? defaultTimers
  const transactions = createTransactions({ local: address, timers })

  function handle(input: Input, now: number): Output[] {
    switch (input.type) {
      case "receive":
        return receive(input.data, input.from, now)
      case "timeout":
        return translate(transactions.expire(now), now)
      case "command":
        return execute(input.command, now)
    }
  }

  function receive(data: Uint8Array, from: Address, now: number): Output[] {
    const result = parseMessage(data)
    if (!result.ok) return [event({ type: "invalid", error: result.error, from })]
    const { message } = result
    if (!isRequest(message)) return translate(transactions.receive(message, from, now), now)
    const via = message.via.map((entry, index) =>
      index === 0 ? withReceived(entry, from.host, from.port) : entry,
    )
    return translate(transactions.receive({ ...message, via }, from, now), now)
  }

  function execute(command: Command, now: number): Output[] {
    if (command.type === "send") return [send(command.message, command.to)]
    if (!isRequestUri(command.uri)) throw new TypeError(`Invalid Request-URI "${command.uri}"`)
    const request = createOptionsRequest(command.uri, { address, aor, random })
    return translate(transactions.send(request, command.to, now), now)
  }

  function translate(outputs: TransactionOutput[], now: number): Output[] {
    return outputs.flatMap((output) =>
      output.type === "send" ? [send(output.message, output.to)] : react(output.event, now),
    )
  }

  function react(happened: TransactionEvent, now: number): Output[] {
    if (happened.type !== "request") return [event(happened)]
    const { request, from, transaction } = happened
    const received = event({ type: "request", request, from })
    if (transaction === undefined) return [received]
    return [received, ...translate(transactions.respond(transaction, reply(request), now), now)]
  }

  function reply(request: SipRequest) {
    const situation = { cancelsInvite: transactions.hasInvite(request) }
    const { status, reason, headers } = answer(request, situation)
    return createResponse(request, status, reason, { toTag: createTag(random), headers })
  }

  return { handle, nextDeadline: () => transactions.nextDeadline() }
}

function send(message: SipMessage, to: Address): Output {
  return { type: "send", data: serializeMessage(message), to }
}

function event(coreEvent: CoreEvent): Output {
  return { type: "event", event: coreEvent }
}
