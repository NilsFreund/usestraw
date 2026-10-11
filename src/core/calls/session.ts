import type { SipMessage, SipRequest, SipResponse } from "../../message/types"
import type { CallMedia } from "../../sdp/types"
import { topVia } from "../../transaction/keys"
import type { TransportAddress } from "../../transport/address"
import type { Authenticator } from "../authenticator"
import type { CallEnd } from "../types"
import { checkInvite } from "../uas"
import { type Media, sameMedia } from "./media"
import { emit, respond, send } from "./outputs"
import { type Repeat, repeatAnswer } from "./repeat"
import { createReply, createRetryLater, INCOMPATIBLE_MEDIA } from "./replies"
import { type Dialog, inDialog, inDialogOf, targetOf } from "./requests"
import type { CallContext, CallOutput } from "./types"

export interface SessionSetup {
  readonly call: string
  readonly dialog: Dialog
  readonly to: TransportAddress
  readonly seq: number
  readonly remoteSeq?: number
  readonly media: Media
  readonly pending?: { readonly repeat: Repeat; readonly offered: boolean }
}

export interface SessionContext extends Omit<CallContext, "credentials" | "trust"> {
  readonly authenticator: Authenticator
}

export interface Session {
  readonly ended: boolean
  readonly deadline: number | undefined
  end(ended?: CallEnd): CallOutput[]
  response(response: SipResponse): CallOutput[]
  timeout(request: SipRequest): CallOutput[]
  matches(request: SipRequest): boolean
  request(request: SipRequest, transaction: string, now: number): CallOutput[]
  acknowledge(ack: SipRequest): CallOutput[]
  expire(now: number): CallOutput[]
}

interface Pending {
  readonly repeat: Repeat
  readonly offered: boolean
  readonly initial: boolean
}

const HANGUP: CallEnd = { by: "local", reason: "hangup" }
export const INCOMPATIBLE: CallEnd = { by: "local", reason: "incompatible" }
// RFC 3326: the BYE says why, so a carrier's trace shows a media mismatch and not a hang-up
const INCOMPATIBLE_REASON = { name: "Reason", value: 'SIP;cause=488;text="Incompatible media"' }
const REMOTE_HANGUP: CallEnd = { by: "remote", reason: "hangup" }

/** The confirmed dialog of a call in either direction: hangups, re-INVITEs, the ACK for our 2xx. */
export function createSession(setup: SessionSetup, context: SessionContext): Session {
  const { call, to, media } = setup
  const { identity, contact, authenticator, timers } = context
  let { dialog, seq, remoteSeq } = setup
  let pending: Pending | undefined = setup.pending && { ...setup.pending, initial: true }
  let state: "live" | "ending" | "ended" = "live"
  let closing = HANGUP
  let bye: string | null | undefined

  function finish(ended: CallEnd): CallOutput[] {
    state = "ended"
    pending = undefined
    return [emit({ type: "call", call, state: "ended", ended })]
  }

  function hangUp(): CallOutput[] {
    seq += 1
    const reason = closing.reason === "incompatible" ? [INCOMPATIBLE_REASON] : []
    const request = inDialog("BYE", dialog, seq, identity, reason)
    bye = branchOf(request)
    const headers = [...request.headers, ...authenticator.authorize(request)]
    return [send({ ...request, headers }, to)]
  }

  // RFC 3261 §15: the callee must not send a BYE before the ACK for its 2xx arrived or timed out
  function end(ended = HANGUP): CallOutput[] {
    if (state !== "live") return []
    state = "ending"
    closing = ended
    if (pending?.initial) return []
    pending = undefined
    return hangUp()
  }

  // Only the branch tells the answer to our BYE apart from one to a BYE for another fork
  function response(reply: SipResponse): CallOutput[] {
    if (branchOf(reply) !== bye || reply.status < 200 || state !== "ending") return []
    // A challenge inside a call may come from the far end, which must never get our password hash
    return finish(closing)
  }

  function timeout(request: SipRequest): CallOutput[] {
    if (branchOf(request) !== bye || state !== "ending") return []
    return finish(closing)
  }

  // RFC 3261 §12.2.2: requests below the last remote CSeq are out of order and get a 500
  function request(incoming: SipRequest, transaction: string, now: number): CallOutput[] {
    const reply = (status: number) => respond(transaction, createReply(incoming, status))
    if (incoming.method === "CANCEL") return [reply(200)]
    if (state === "ended") return [reply(481)]
    if (remoteSeq !== undefined && incoming.cseq.seq < remoteSeq) return [reply(500)]
    remoteSeq = incoming.cseq.seq
    if (incoming.method === "BYE") {
      return [reply(200), ...finish(state === "ending" ? closing : REMOTE_HANGUP)]
    }
    if (state === "ending") return [reply(481)]
    return reinvite(incoming, transaction, now)
  }

  // RFC 3264 §8: we answer a new offer or make one, and an offer we cannot play keeps the old session
  function reinvite(invite: SipRequest, transaction: string, now: number): CallOutput[] {
    const refusal = checkInvite(invite)
    if (refusal) {
      const { status, headers } = refusal
      return [respond(transaction, createReply(invite, status, { headers }))]
    }
    if (pending) return [respond(transaction, createRetryLater(invite, identity.random))]
    const offered = invite.body.length === 0
    const before = media.current
    const sdp = offered ? media.offer() : media.answer(invite.body)
    if (!sdp)
      return [respond(transaction, createReply(invite, 488, { headers: [INCOMPATIBLE_MEDIA] }))]
    const ok = createReply(invite, 200, { contact, sdp })
    pending = { repeat: repeatAnswer(transaction, ok, now, timers), offered, initial: false }
    // RFC 3261 §12.2.2: a 2xx to a target refresh moves the remote target to the new Contact
    dialog = { ...dialog, target: targetOf(invite) ?? dialog.target }
    return [respond(transaction, ok), ...changed(before)]
  }

  function changed(before: CallMedia | undefined): CallOutput[] {
    const after = media.current
    if (!after || (before && sameMedia(before, after))) return []
    return [emit({ type: "call", call, state: "live", media: after })]
  }

  // RFC 3264 §4: an offer in our 2xx is answered in the ACK; a new call without one hangs up
  function acknowledge(ack: SipRequest): CallOutput[] {
    if (!pending || ack.cseq.seq !== pending.repeat.seq || !inDialogOf(dialog, ack.to, ack.from)) {
      return []
    }
    const { offered, initial } = pending
    pending = undefined
    if (state === "ending") return hangUp()
    const before = initial ? undefined : media.current
    if (!offered || media.read(ack.body) || !initial) return changed(before)
    state = "ending"
    closing = INCOMPATIBLE
    return hangUp()
  }

  // RFC 3261 §13.3.1.4 and §14.2: a 2xx that is never acknowledged ends the session with a BYE
  function expire(now: number): CallOutput[] {
    if (!pending) return []
    const outputs = pending.repeat.expire(now)
    if (!pending.repeat.expired) return outputs
    pending = undefined
    if (state === "live") {
      state = "ending"
      closing = { by: "remote", reason: "dropped" }
    }
    return hangUp()
  }

  return {
    get ended() {
      return state === "ended"
    },
    get deadline() {
      return pending?.repeat.deadline
    },
    end,
    response,
    timeout,
    matches: (request) => inDialogOf(dialog, request.to, request.from),
    request,
    acknowledge,
    expire,
  }
}

function branchOf(message: SipMessage): string | null | undefined {
  return topVia(message).params.get("branch")
}
