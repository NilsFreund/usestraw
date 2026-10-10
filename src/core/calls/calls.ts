import type { NameAddr } from "../../message/fields/name-addr"
import type { SipRequest, SipResponse } from "../../message/types"
import type { Identity } from "../requests"
import type { Credentials } from "../types"
import { type CallOutput, type CallSetup, createOutgoing, type Outgoing } from "./outgoing"

export interface Calls {
  owns(call: string): boolean
  start(setup: CallSetup, now: number): CallOutput[]
  end(call: string, now: number): CallOutput[]
  response(response: SipResponse, now: number): CallOutput[]
  timeout(request: SipRequest, now: number): CallOutput[]
  matches(request: SipRequest): boolean
  request(request: SipRequest, transaction: string, now: number): CallOutput[]
  expire(now: number): CallOutput[]
  nextDeadline(): number | undefined
}

interface Entry {
  readonly call: Outgoing
  removeAt?: number
}

// Ended calls linger for 64·T1 so late 2xx retransmissions still get their ACK
export function createCalls(
  identity: Identity,
  contact: NameAddr,
  credentials: Credentials | undefined,
  linger: number,
): Calls {
  const calls = new Map<string, Entry>()

  function track(id: string, outputs: CallOutput[], now: number): CallOutput[] {
    const entry = calls.get(id)
    if (entry?.call.ended && entry.removeAt === undefined) entry.removeAt = now + linger
    return outputs
  }

  function on(id: string, now: number, act: (call: Outgoing) => CallOutput[]): CallOutput[] {
    const entry = calls.get(id)
    return entry ? track(id, act(entry.call), now) : []
  }

  function find(request: SipRequest): string | undefined {
    const entry = calls.get(request.callId)
    return entry?.call.matches(request) ? request.callId : undefined
  }

  return {
    owns: (id) => calls.has(id),
    start: (setup, now) => {
      const call = createOutgoing(setup, identity, contact, credentials, linger)
      calls.set(setup.call, { call })
      return track(setup.call, call.start(), now)
    },
    end: (id, now) => on(id, now, (call) => call.end(now)),
    response: (response, now) => on(response.callId, now, (call) => call.response(response, now)),
    timeout: (request, now) => on(request.callId, now, (call) => call.timeout(request)),
    matches: (request) => find(request) !== undefined,
    request: (request, transaction, now) =>
      on(request.callId, now, (call) => call.request(request, transaction)),
    expire: (now) => {
      const outputs: CallOutput[] = []
      for (const [id, entry] of calls) {
        outputs.push(...track(id, entry.call.expire(now), now))
        if (entry.removeAt !== undefined && entry.removeAt <= now) calls.delete(id)
      }
      return outputs
    },
    nextDeadline: () => {
      let next: number | undefined
      for (const { call, removeAt } of calls.values()) {
        for (const at of [call.deadline, removeAt]) {
          if (at !== undefined && (next === undefined || at < next)) next = at
        }
      }
      return next
    },
  }
}
