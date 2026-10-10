import type { SipRequest, SipResponse } from "../message/types"
import { isReliable, type TransportAddress } from "../transport/address"
import { createAlarms } from "./alarms"
import { clientKey } from "./keys"
import { notify, send } from "./outputs"
import { defaultTimers, type TimerSettings, transactionTimeout } from "./timers"
import type { ClientTransaction, TransactionOutput } from "./types"

export type ClientNonInviteState = "trying" | "proceeding" | "completed" | "terminated"

export function createClientNonInvite(
  request: SipRequest,
  to: TransportAddress,
  timers: TimerSettings = defaultTimers,
): ClientTransaction<ClientNonInviteState> {
  const reliable = isReliable(to)
  const alarms = createAlarms<"E" | "F" | "K">()
  let state: ClientNonInviteState = "trying"
  let interval = timers.t1

  function start(now: number): TransactionOutput[] {
    if (!reliable) alarms.set("E", now + interval)
    alarms.set("F", now + transactionTimeout(timers))
    return [send(request, to)]
  }

  function receive(
    response: SipResponse,
    from: TransportAddress,
    now: number,
  ): TransactionOutput[] {
    if (state === "completed" || state === "terminated") return []
    if (response.status < 200) state = "proceeding"
    else complete(now)
    return [notify({ type: "response", response, from })]
  }

  function complete(now: number): void {
    alarms.clear("E", "F")
    state = "completed"
    if (reliable) terminate()
    else alarms.set("K", now + timers.t4)
  }

  function expire(now: number): TransactionOutput[] {
    const due = alarms.take(now)
    if (due.includes("F")) return [timeout()]
    if (due.includes("K")) terminate()
    return due.includes("E") ? [retransmit(now)] : []
  }

  function retransmit(now: number): TransactionOutput {
    interval = state === "proceeding" ? timers.t2 : Math.min(2 * interval, timers.t2)
    alarms.set("E", now + interval)
    return send(request, to)
  }

  function timeout(): TransactionOutput {
    terminate()
    return notify({ type: "timeout", request })
  }

  function terminate(): void {
    state = "terminated"
    alarms.clear("E", "F", "K")
  }

  return {
    key: clientKey(request),
    get state() {
      return state
    },
    start,
    receive,
    nextDeadline: () => alarms.next(),
    expire,
  }
}
