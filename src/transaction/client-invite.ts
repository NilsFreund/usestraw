import type { SipRequest, SipResponse } from "../message/types"
import { type Address, isReliable } from "../transport/address"
import { createAck } from "./ack"
import { createAlarms } from "./alarms"
import { clientKey } from "./keys"
import { notify, send } from "./outputs"
import { defaultTimers, type TimerSettings, transactionTimeout } from "./timers"
import type { ClientTransaction, TransactionOutput } from "./types"

export type ClientInviteState = "calling" | "proceeding" | "completed" | "accepted" | "terminated"

export function createClientInvite(
  invite: SipRequest,
  to: Address,
  timers: TimerSettings = defaultTimers,
): ClientTransaction<ClientInviteState> {
  const reliable = isReliable(to)
  const alarms = createAlarms<"A" | "B" | "D" | "M">()
  let state: ClientInviteState = "calling"
  let interval = timers.t1

  function start(now: number): TransactionOutput[] {
    if (!reliable) alarms.set("A", now + interval)
    alarms.set("B", now + transactionTimeout(timers))
    return [send(invite, to)]
  }

  function receive(response: SipResponse, from: Address, now: number): TransactionOutput[] {
    const passed = notify({ type: "response", response, from })
    switch (state) {
      case "calling":
      case "proceeding":
        return [...advance(response, now), passed]
      case "completed":
        // RFC 6026 §8.4: a 2xx from another branch after a final still reaches the TU
        if (response.status >= 300) return [send(createAck(invite, response), to)]
        return response.status >= 200 ? [passed] : []
      case "accepted":
        return response.status >= 200 && response.status < 300 ? [passed] : []
      case "terminated":
        return []
    }
  }

  function advance(response: SipResponse, now: number): TransactionOutput[] {
    alarms.clear("A", "B")
    if (response.status < 200) {
      state = "proceeding"
      return []
    }
    if (response.status < 300) {
      state = "accepted"
      alarms.set("M", now + transactionTimeout(timers))
      return []
    }
    state = "completed"
    if (reliable) state = "terminated"
    else alarms.set("D", now + timers.d)
    return [send(createAck(invite, response), to)]
  }

  function expire(now: number): TransactionOutput[] {
    const due = alarms.take(now)
    if (due.includes("B")) return [timeout()]
    if (due.includes("D") || due.includes("M")) terminate()
    return due.includes("A") ? [retransmit(now)] : []
  }

  function retransmit(now: number): TransactionOutput {
    interval *= 2
    alarms.set("A", now + interval)
    return send(invite, to)
  }

  function timeout(): TransactionOutput {
    terminate()
    return notify({ type: "timeout", request: invite })
  }

  function terminate(): void {
    state = "terminated"
    alarms.clear("A", "B", "D", "M")
  }

  return {
    key: clientKey(invite),
    get state() {
      return state
    },
    start,
    receive,
    nextDeadline: () => alarms.next(),
    expire,
  }
}
