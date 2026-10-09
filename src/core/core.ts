import { isIp } from "../message/fields/host"
import { isRequestUri, isUri } from "../message/fields/uri"
import { withReceived } from "../message/fields/via"
import { MAX_MESSAGE_SIZE } from "../message/limits"
import { parseMessage } from "../message/parse"
import { serializeMessage } from "../message/serialize"
import { show } from "../message/syntax"
import { isRequest, type SipMessage, type SipRequest } from "../message/types"
import { checkTime } from "../support/time"
import { topVia } from "../transaction/keys"
import { defaultTimers, type TimerSettings } from "../transaction/timers"
import { createTransactions } from "../transaction/transactions"
import type { TransactionOutput } from "../transaction/types"
import { type Address, isAddress } from "../transport/address"
import { replyAddress } from "../transport/routing"
import { createOptionsRequest } from "./requests"
import { createStateless } from "./stateless"
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
  checkAddress(address)
  if (!isUri(aor)) throw new TypeError(`Invalid address of record ${show(aor)}`)
  const timers = options.timers ?? defaultTimers
  const transactions = createTransactions({ local: address, timers })
  const stateless = createStateless(random)

  function handle(input: Input, now: number): Output[] {
    checkTime(now)
    switch (input.type) {
      case "receive":
        return receive(input.data, input.from, now)
      case "timeout":
        return translate(transactions.expire(now))
      case "command":
        return execute(input.command, now)
    }
  }

  function receive(data: Uint8Array, from: Address, now: number): Output[] {
    checkAddress(from)
    if (!isIp(from.host))
      throw new TypeError(`The source must be an IP address, got ${show(from.host)}`)
    const result = parseMessage(data)
    if (!result.ok) return [event({ type: "invalid", error: result.error, from })]
    const { message } = result
    if (!isRequest(message)) return translate(transactions.receive(message, from, now))
    const via = message.via.map((entry, index) =>
      index === 0 ? withReceived(entry, from.host, from.port) : entry,
    )
    return receiveRequest({ ...message, via }, from)
  }

  function receiveRequest(request: SipRequest, from: Address): Output[] {
    if (request.method === "ACK") {
      return stateless.acknowledges(request) ? [] : [event({ type: "request", request, from })]
    }
    const reply = answer(request)
    const answered = event({ type: "answered", request, from, status: reply.status })
    const data = serializeMessage(stateless.reply(request, reply))
    if (data.length > MAX_MESSAGE_SIZE) return [answered]
    return [answered, { type: "send", data, to: replyAddress(topVia(request), from) }]
  }

  function execute(command: Command, now: number): Output[] {
    checkAddress(command.to)
    if (command.type === "send") return [send(command.message, command.to)]
    if (!isRequestUri(command.uri)) throw new TypeError(`Invalid Request-URI ${show(command.uri)}`)
    const request = createOptionsRequest(command.uri, { address, aor, random })
    return translate(transactions.send(request, command.to, now))
  }

  function translate(outputs: TransactionOutput[]): Output[] {
    return outputs.map((output) =>
      output.type === "send" ? send(output.message, output.to) : event(output.event),
    )
  }

  return { handle, nextDeadline: () => transactions.nextDeadline() }
}

function checkAddress(address: Address): void {
  if (!isAddress(address)) throw new TypeError(`Invalid address ${show(address)}`)
}

function send(message: SipMessage, to: Address): Output {
  return { type: "send", data: serializeMessage(message), to }
}

function event(coreEvent: CoreEvent): Output {
  return { type: "event", event: coreEvent }
}
