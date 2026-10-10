import type { SipResponse } from "../../message/types"
import type { TimerSettings } from "../../transaction/timers"
import { transactionTimeout } from "../../transaction/timers"
import { respond } from "./outputs"
import type { CallOutput } from "./types"

export interface Repeat {
  readonly seq: number
  readonly deadline: number | undefined
  readonly expired: boolean
  expire(now: number): CallOutput[]
}

// RFC 3261 §13.3.1.4: the UAS core resends a 2xx with T1 doubling up to T2 until the ACK or 64·T1
export function repeatAnswer(
  transaction: string,
  response: SipResponse,
  now: number,
  timers: TimerSettings,
): Repeat {
  const until = now + transactionTimeout(timers)
  let interval = timers.t1
  let next = now + interval
  let expired = false

  function expire(at: number): CallOutput[] {
    if (next > at) return []
    if (at >= until) {
      expired = true
      return []
    }
    interval = Math.min(interval * 2, timers.t2)
    next = Math.min(at + interval, until)
    return [respond(transaction, response)]
  }

  return {
    seq: response.cseq.seq,
    get deadline() {
      return expired ? undefined : next
    },
    get expired() {
      return expired
    },
    expire,
  }
}
