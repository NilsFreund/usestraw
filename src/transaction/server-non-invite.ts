import type { SipRequest, SipResponse } from "../message/types"
import { type Address, isReliable } from "../transport/address"
import { createAlarms } from "./alarms"
import { serverKey } from "./keys"
import { send } from "./outputs"
import { defaultTimers, type TimerSettings, transactionTimeout } from "./timers"
import type { ServerTransaction, TransactionOutput } from "./types"

export type ServerNonInviteState = "trying" | "proceeding" | "completed" | "terminated"

export function createServerNonInvite(
  request: SipRequest,
  replyTo: Address,
  timers: TimerSettings = defaultTimers,
): ServerTransaction<ServerNonInviteState> {
  const reliable = isReliable(replyTo)
  let to = replyTo
  const alarms = createAlarms<"J">()
  let state: ServerNonInviteState = "trying"
  let latest: SipResponse | undefined

  function receive(_: SipRequest, from: Address): TransactionOutput[] {
    if (state === "terminated") return []
    to = from
    return latest ? [send(latest, to)] : []
  }

  function respond(response: SipResponse, now: number): TransactionOutput[] {
    if (state === "completed" || state === "terminated") return []
    latest = response
    if (response.status < 200) state = "proceeding"
    else if (reliable) state = "terminated"
    else {
      state = "completed"
      alarms.set("J", now + transactionTimeout(timers))
    }
    return [send(response, to)]
  }

  function expire(now: number): TransactionOutput[] {
    if (alarms.take(now).length > 0) state = "terminated"
    return []
  }

  return {
    key: serverKey(request),
    get state() {
      return state
    },
    start: () => [],
    receive,
    respond,
    nextDeadline: () => alarms.next(),
    expire,
  }
}
