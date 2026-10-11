import type { SipRequest, SipResponse } from "../message/types"
import { isReliable, type TransportAddress } from "../transport/address"
import { createAlarms } from "./alarms"
import { acknowledges, serverKey } from "./keys"
import { emit, send } from "./outputs"
import { defaultTimers, type TimerSettings, transactionTimeout } from "./timers"
import { createTrying } from "./trying"
import type { ServerTransaction, TransactionOutput } from "./types"

export type ServerInviteState = "proceeding" | "completed" | "confirmed" | "accepted" | "terminated"

export function createServerInvite(
  invite: SipRequest,
  replyTo: TransportAddress,
  timers: TimerSettings = defaultTimers,
): ServerTransaction<ServerInviteState> {
  const reliable = isReliable(replyTo)
  const alarms = createAlarms<"trying" | "G" | "H" | "I" | "L">()
  let to = replyTo
  let state: ServerInviteState = "proceeding"
  let latest: SipResponse | undefined
  let started = 0
  let interval = timers.t1

  function start(now: number): TransactionOutput[] {
    started = now
    alarms.set("trying", now + timers.trying)
    return []
  }

  function current(now: number): SipResponse {
    return latest ?? createTrying(invite, now - started)
  }

  function receive(request: SipRequest, from: TransportAddress, now: number): TransactionOutput[] {
    if (request.method === "ACK") return acknowledge(request, now)
    if (state === "confirmed" || state === "terminated") return []
    to = from
    if (state === "accepted") return []
    alarms.clear("trying")
    return [send(current(now), to)]
  }

  function acknowledge(ack: SipRequest, now: number): TransactionOutput[] {
    if (state !== "completed" || !acknowledges(ack, current(now))) return []
    alarms.clear("G", "H")
    state = "confirmed"
    if (reliable) state = "terminated"
    else alarms.set("I", now + timers.t4)
    return []
  }

  function respond(response: SipResponse, now: number): TransactionOutput[] {
    const success = response.status >= 200 && response.status < 300
    if (state === "accepted") return success ? [send(response, to)] : []
    if (state !== "proceeding") return []
    alarms.clear("trying")
    latest = response
    if (response.status >= 300) reject(now)
    else if (success) {
      state = "accepted"
      alarms.set("L", now + transactionTimeout(timers))
    }
    return [send(response, to)]
  }

  function reject(now: number): void {
    state = "completed"
    if (!reliable) alarms.set("G", now + interval)
    alarms.set("H", now + transactionTimeout(timers))
  }

  function expire(now: number): TransactionOutput[] {
    const due = alarms.take(now)
    if (due.includes("H")) return [unacknowledged(now)]
    if (due.includes("I") || due.includes("L")) terminate()
    if (due.includes("G")) return [retransmit(now)]
    return due.includes("trying") ? [send(current(now), to)] : []
  }

  function retransmit(now: number): TransactionOutput {
    interval = Math.min(2 * interval, timers.t2)
    alarms.set("G", now + interval)
    return send(current(now), to)
  }

  function unacknowledged(now: number): TransactionOutput {
    terminate()
    return emit({ type: "unacknowledged", request: invite, response: current(now) })
  }

  function terminate(): void {
    state = "terminated"
    alarms.clear("trying", "G", "H", "I", "L")
  }

  return {
    key: serverKey(invite),
    get state() {
      return state
    },
    start,
    receive,
    respond,
    nextDeadline: () => alarms.next(),
    expire,
  }
}
