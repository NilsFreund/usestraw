import { createResponse } from "../message/response"
import type { SipRequest, SipResponse } from "../message/types"
import { type Address, isReliable } from "../transport/address"
import { createAlarms } from "./alarms"
import { acknowledges, serverKey } from "./keys"
import { notify, send } from "./outputs"
import { defaultTimers, type TimerSettings, transactionTimeout } from "./timers"
import type { ServerTransaction, TransactionOutput } from "./types"

export type ServerInviteState = "proceeding" | "completed" | "confirmed" | "accepted" | "terminated"

export function createServerInvite(
  invite: SipRequest,
  replyTo: Address,
  timers: TimerSettings = defaultTimers,
): ServerTransaction<ServerInviteState> {
  const reliable = isReliable(replyTo)
  const alarms = createAlarms<"trying" | "G" | "H" | "I" | "L">()
  let to = replyTo
  let state: ServerInviteState = "proceeding"
  let latest = createResponse(invite, 100, "Trying")
  let interval = timers.t1

  function start(now: number): TransactionOutput[] {
    alarms.set("trying", now + timers.trying)
    return []
  }

  function receive(request: SipRequest, from: Address, now: number): TransactionOutput[] {
    if (request.method === "ACK") return acknowledge(request, now)
    if (state !== "proceeding" && state !== "completed") return []
    to = from
    alarms.clear("trying")
    return [send(latest, to)]
  }

  function acknowledge(ack: SipRequest, now: number): TransactionOutput[] {
    if (state !== "completed" || !acknowledges(ack, latest)) return []
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
    if (due.includes("H")) return [unacknowledged()]
    if (due.includes("I") || due.includes("L")) terminate()
    if (due.includes("G")) return [retransmit(now)]
    return due.includes("trying") ? [send(latest, to)] : []
  }

  function retransmit(now: number): TransactionOutput {
    interval = Math.min(2 * interval, timers.t2)
    alarms.set("G", now + interval)
    return send(latest, to)
  }

  function unacknowledged(): TransactionOutput {
    terminate()
    return notify({ type: "unacknowledged", request: invite, response: latest })
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
