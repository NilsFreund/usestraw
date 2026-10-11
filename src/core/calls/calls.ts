import type { SipRequest, SipResponse } from "../../message/types"
import type { MediaAddress } from "../../sdp/types"
import { earliest } from "../../support/time"
import { transactionTimeout } from "../../transaction/timers"
import { createIncoming, type IncomingSetup } from "./incoming"
import { createOutgoing, type OutgoingSetup } from "./outgoing"
import { respond } from "./outputs"
import { createReply } from "./replies"
import type { CallContext, CallOutput, CallState } from "./types"

export interface Calls {
  owns(call: string): boolean
  collides(invite: SipRequest): boolean
  active(): number
  tracked(): number
  start(setup: OutgoingSetup, now: number): CallOutput[]
  receive(setup: IncomingSetup, now: number): CallOutput[]
  accept(call: string, media: MediaAddress, now: number): CallOutput[]
  end(call: string, now: number, status?: number): CallOutput[]
  response(response: SipResponse, now: number): CallOutput[]
  timeout(request: SipRequest, now: number): CallOutput[]
  matches(request: SipRequest): boolean
  request(request: SipRequest, transaction: string, now: number): CallOutput[]
  acknowledge(ack: SipRequest, now: number): CallOutput[]
  expire(now: number): CallOutput[]
  nextDeadline(): number | undefined
}

interface Entry {
  readonly call: CallState
  removeAt?: number
}

// Ended calls linger for 64·T1 so late retransmissions still find their call
export function createCalls(context: CallContext): Calls {
  const linger = transactionTimeout(context.timers)
  const calls = new Map<string, Entry>()

  function track(id: string, outputs: CallOutput[], now: number): CallOutput[] {
    const entry = calls.get(id)
    if (entry?.call.ended && entry.removeAt === undefined) entry.removeAt = now + linger
    return outputs
  }

  function on(id: string, now: number, act: (call: CallState) => CallOutput[]): CallOutput[] {
    const entry = calls.get(id)
    return entry ? track(id, act(entry.call), now) : []
  }

  function add(id: string, call: CallState, now: number): CallOutput[] {
    calls.set(id, { call })
    return track(id, call.start(), now)
  }

  function request(incoming: SipRequest, transaction: string, now: number): CallOutput[] {
    if (calls.has(incoming.callId)) {
      return on(incoming.callId, now, (call) => call.request(incoming, transaction, now))
    }
    return [respond(transaction, createReply(incoming, 481))]
  }

  return {
    owns: (id) => calls.has(id),

    collides: (invite) => {
      const entry = calls.get(invite.callId)
      return entry !== undefined && (!entry.call.ended || entry.call.merges(invite))
    },
    active: () => [...calls.values()].filter((entry) => !entry.call.ended).length,
    tracked: () => calls.size,
    start: (setup, now) => add(setup.call, createOutgoing(setup, context), now),
    receive: (setup, now) => add(setup.invite.callId, createIncoming(setup, context, now), now),
    accept: (id, media, now) => on(id, now, (call) => call.accept(media, now)),
    end: (id, now, status) => on(id, now, (call) => call.end(now, status)),
    response: (response, now) => on(response.callId, now, (call) => call.response(response, now)),
    timeout: (request, now) => on(request.callId, now, (call) => call.timeout(request)),
    matches: (request) => calls.get(request.callId)?.call.matches(request) ?? false,
    request,
    acknowledge: (ack, now) => on(ack.callId, now, (call) => call.acknowledge(ack)),
    expire: (now) => {
      const outputs: CallOutput[] = []
      for (const [id, entry] of calls) {
        outputs.push(...track(id, entry.call.expire(now), now))
        if (entry.removeAt !== undefined && entry.removeAt <= now) calls.delete(id)
      }
      return outputs
    },
    nextDeadline: () =>
      earliest([...calls.values()].flatMap(({ call, removeAt }) => [call.deadline, removeAt])),
  }
}
