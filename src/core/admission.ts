import type { SipRequest } from "../message/types"
import { isPlayable } from "../sdp/negotiate"
import { inRange, type Range } from "../support/ip"
import type { Transactions } from "../transaction/transactions"
import type { TransportAddress } from "../transport/address"
import type { Calls } from "./calls/calls"
import { sdpOf } from "./calls/media"
import { INCOMPATIBLE_MEDIA } from "./calls/replies"
import { type Answer, answerWith, checkInvite } from "./uas"

const LOOP: Answer = answerWith(482)
const BUSY: Answer = answerWith(486)
const UNPLAYABLE: Answer = answerWith(488, [INCOMPATIBLE_MEDIA])
const FULL: Answer = answerWith(503, [{ name: "Retry-After", value: "5" }])

/** Who may send requests, and which new calls the core takes. */
export interface Admission {
  accepts(request: SipRequest, from: TransportAddress): boolean
  admit(invite: SipRequest): Answer | undefined
}

export interface AdmissionSetup {
  readonly accepted: readonly Range[] | undefined
  readonly maxCalls: number
  readonly calls: Calls
  readonly transactions: Transactions
  readonly appMedia: boolean
}

export function createAdmission(setup: AdmissionSetup): Admission {
  const { accepted, maxCalls, calls, transactions, appMedia } = setup
  // Ended calls linger for 64·T1, so a flood of short calls is capped before it costs memory
  const capacity = Math.max(64, 4 * maxCalls)

  // Strangers only get in with requests inside a call, whose ids they must guess, and never CANCEL
  function accepts(request: SipRequest, from: TransportAddress): boolean {
    if (accepted === undefined || accepted.some((range) => inRange(from.host, range))) {
      return true
    }
    return request.method !== "CANCEL" && calls.matches(request)
  }

  // RFC 3261 §8.2.2.2: a Call-ID stays taken while its call lives, and its own INVITE coming back is merged
  function admit(invite: SipRequest): Answer | undefined {
    if (invite.to.params.has("tag") || transactions.hasInvite(invite)) return undefined
    const refusal = checkInvite(invite)
    if (refusal) return refusal
    const usable = appMedia ? sdpOf(invite.body) !== undefined : isPlayable(invite.body)
    if (invite.body.length > 0 && !usable) {
      return UNPLAYABLE
    }
    if (calls.collides(invite)) return LOOP
    if (calls.active() >= maxCalls) return BUSY
    return calls.tracked() >= capacity ? FULL : undefined
  }

  return { accepts, admit }
}
