import { isRequestUri, isUri } from "../message/fields/uri"
import { formatHost, sameHost, withReceived } from "../message/fields/via"
import { parseMessage } from "../message/parse"
import { createResponse } from "../message/response"
import { serializeMessage } from "../message/serialize"
import { isRequest, type SipMessage, type SipRequest, type SipResponse } from "../message/types"
import { createBranch, createCallId, createTag } from "./ids"
import { replyAddress } from "./routing"
import { earliest } from "./time"
import type { Address, Command, CoreEvent, Input, Output, Random } from "./types"
import { answer } from "./uas"

export interface CoreOptions {
  readonly address: Address
  readonly aor: string
  readonly random: Random
}

export interface Core {
  handle(input: Input, now: number): Output[]
  nextDeadline(): number | undefined
}

const T1 = 500
const TIMER_F = 64 * T1

export function createCore(options: CoreOptions): Core {
  const { address, aor, random } = options
  if (!isUri(aor)) throw new TypeError(`Invalid address of record "${aor}"`)
  const pending = new Map<string, { request: SipRequest; deadline: number }>()

  function handle(input: Input, now: number): Output[] {
    switch (input.type) {
      case "receive":
        return receive(input.data, input.from)
      case "timeout":
        return expire(now)
      case "command":
        return execute(input.command, now)
    }
  }

  function nextDeadline(): number | undefined {
    return earliest(Array.from(pending.values(), (entry) => entry.deadline))
  }

  function receive(data: Uint8Array, from: Address): Output[] {
    const result = parseMessage(data)
    if (!result.ok) return [event({ type: "invalid", error: result.error, from })]
    if (!isRequest(result.message)) return onResponse(result.message, from)
    const via = result.message.via.map((entry, index) =>
      index === 0 ? withReceived(entry, from.host, from.port) : entry,
    )
    return onRequest({ ...result.message, via }, from)
  }

  function onRequest(request: SipRequest, from: Address): Output[] {
    const received = event({ type: "request", request, from })
    if (request.method === "ACK") return [received]
    const { status, reason, headers } = answer(request)
    const response = createResponse(request, status, reason, { toTag: createTag(random), headers })
    return [received, send(response, replyAddress(request.via[0], from))]
  }

  function onResponse(response: SipResponse, from: Address): Output[] {
    const branch = response.via[0]?.params.get("branch") ?? ""
    const entry = pending.get(branch)
    if (!entry || !isOwnResponse(response, entry.request)) {
      return [event({ type: "stray", response, from })]
    }
    if (response.status >= 200) pending.delete(branch)
    return [event({ type: "response", response, from })]
  }

  function isOwnResponse(response: SipResponse, request: SipRequest): boolean {
    const [via, ...rest] = response.via
    return (
      rest.length === 0 &&
      via !== undefined &&
      via.transport === address.transport &&
      sameHost(via.host, address.host) &&
      via.port === address.port &&
      response.cseq.method === request.cseq.method
    )
  }

  function expire(now: number): Output[] {
    const outputs: Output[] = []
    for (const [branch, { request, deadline }] of pending) {
      if (deadline > now) continue
      pending.delete(branch)
      outputs.push(event({ type: "timeout", request }))
    }
    return outputs
  }

  function execute(command: Command, now: number): Output[] {
    if (command.type === "send") return [send(command.message, command.to)]
    if (!isRequestUri(command.uri)) throw new TypeError(`Invalid Request-URI "${command.uri}"`)
    const branch = createBranch(random)
    const request = createOptions(command.uri, branch)
    pending.set(branch, { request, deadline: now + TIMER_F })
    return [send(request, command.to)]
  }

  function createOptions(uri: string, branch: string): SipRequest {
    return {
      method: "OPTIONS",
      uri,
      via: [
        {
          transport: address.transport,
          host: formatHost(address.host),
          port: address.port,
          params: new Map([
            ["branch", branch],
            ["rport", null],
          ]),
        },
      ],
      maxForwards: 70,
      from: { uri: aor, params: new Map([["tag", createTag(random)]]) },
      to: { uri, params: new Map() },
      callId: createCallId(random),
      cseq: { seq: 1, method: "OPTIONS" },
      contact: [],
      headers: [],
      body: new Uint8Array(),
    }
  }

  return { handle, nextDeadline }
}

function send(message: SipMessage, to: Address): Output {
  return { type: "send", data: serializeMessage(message), to }
}

function event(coreEvent: CoreEvent): Output {
  return { type: "event", event: coreEvent }
}
