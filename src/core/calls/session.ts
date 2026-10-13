import type { SipMessage, SipRequest, SipResponse } from "../../message/types"
import { earliest } from "../../support/time"
import { serverKey, topVia } from "../../transaction/keys"
import type { TransportAddress } from "../../transport/address"
import type { Authenticator } from "../authenticator"
import type { CallEnd } from "../types"
import { checkInvite } from "../uas"
import { type Media, type Shown, sameShown, sdpOf } from "./media"
import { emit, respond, send } from "./outputs"
import { type Repeat, repeatAnswer } from "./repeat"
import { createReply, createRetryLater, INCOMPATIBLE_MEDIA } from "./replies"
import { type Dialog, inDialog, inDialogOf, targetOf } from "./requests"
import type { CallContext, CallOutput } from "./types"

export interface SessionSetup {
  readonly call: string
  readonly tag: string
  readonly dialog: Dialog
  readonly to: TransportAddress
  readonly seq: number
  readonly remoteSeq?: number
  readonly media: Media
  readonly pending?: { readonly repeat: Repeat; readonly offered: boolean }
}

export interface SessionContext extends Omit<CallContext, "credentials" | "trust" | "appMedia"> {
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
  answer(sdp: string, now: number): CallOutput[]
  expire(now: number): CallOutput[]
}

// A re-INVITE that waits for the app: to answer its offer, or to offer when it brought none
interface Asked {
  readonly invite: SipRequest
  readonly transaction: string
  readonly until: number
  readonly offering: boolean
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
// The app makes WebRTC's SDP at once; an app that never does keeps the old session
const ANSWER_WAIT = 10_000
const NO_ANSWER = { name: "Warning", value: '399 straw "No answer from the app in time"' }

/** The confirmed dialog of a call in either direction: hangups, re-INVITEs, the ACK for our 2xx. */
export function createSession(setup: SessionSetup, context: SessionContext): Session {
  const { call, tag, to, media } = setup
  const { identity, contact, authenticator, timers } = context
  let { dialog, seq, remoteSeq } = setup
  let pending: Pending | undefined = setup.pending && { ...setup.pending, initial: true }
  let asked: Asked | undefined
  let state: "live" | "ending" | "ended" = "live"
  let closing = HANGUP
  let bye: string | null | undefined

  function live(shown: Shown = {}): CallOutput {
    return emit({ type: "call", call, state: "live", ...shown })
  }

  function finish(ended: CallEnd): CallOutput[] {
    state = "ended"
    pending = undefined
    return [...release(487), emit({ type: "call", call, state: "ended", ended })]
  }

  // RFC 3261 §15.1.2: a call that ends answers the re-INVITE it still owes an answer to
  function release(status: number): CallOutput[] {
    if (!asked) return []
    const { invite, transaction } = asked
    asked = undefined
    const headers = status === 488 ? [NO_ANSWER] : []
    return [respond(transaction, createReply(invite, status, { headers }))]
  }

  // A withdrawn offer leaves the call as it was, and the app rolls back what it began
  function withdraw(status: number): CallOutput[] {
    return [...release(status), live({ description: { type: "rollback" } })]
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
    return [...release(487), ...hangUp()]
  }

  // Only the branch tells the answer to our BYE apart from one to a BYE for another fork
  function response(reply: SipResponse): CallOutput[] {
    if (branchOf(reply) !== bye || reply.status < 200 || state !== "ending") return []
    // Any final answer ends it: a challenge may come from the far end, which must never get our password hash
    return finish(closing)
  }

  function timeout(request: SipRequest): CallOutput[] {
    if (branchOf(request) !== bye || state !== "ending") return []
    return finish(closing)
  }

  // RFC 3261 §9.2: a CANCEL of the re-INVITE that waits for the app ends it with 487
  function cancel(request: SipRequest, transaction: string): CallOutput[] {
    const ok = respond(transaction, createReply(request, 200, { tag }))
    const target = serverKey({ ...request, method: "INVITE" })
    return asked?.transaction === target ? [ok, ...withdraw(487)] : [ok]
  }

  // RFC 3261 §12.2.2: requests below the last remote CSeq are out of order and get a 500
  function request(incoming: SipRequest, transaction: string, now: number): CallOutput[] {
    const reply = (status: number) => respond(transaction, createReply(incoming, status))
    if (incoming.method === "CANCEL") return cancel(incoming, transaction)
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
    if (pending || asked) {
      return [respond(transaction, createRetryLater(invite, identity.random))]
    }
    if (media.use) return ask(invite, transaction, now)
    const offered = invite.body.length === 0
    const before = media.shown("answer")
    const sdp = offered ? media.offer() : media.answer(invite.body)
    if (!sdp) return [refuse(invite, transaction)]
    return [...accepted(invite, transaction, sdp, offered, now), ...changed(before)]
  }

  // JSEP: the browser answers a new offer, and makes a fresh offer for a re-INVITE without one
  function ask(invite: SipRequest, transaction: string, now: number): CallOutput[] {
    const offering = invite.body.length === 0
    const offer = sdpOf(invite.body)
    if (!offering && offer === undefined) return [refuse(invite, transaction)]
    const same = offering ? undefined : media.answer(invite.body)
    if (same) return accepted(invite, transaction, same, false, now)
    asked = { invite, transaction, until: now + ANSWER_WAIT, offering }
    const shown = offer === undefined ? {} : { description: { type: "offer", sdp: offer } as const }
    return [emit({ type: "call", call, state: "offer", ...shown })]
  }

  function refuse(invite: SipRequest, transaction: string): CallOutput {
    return respond(transaction, createReply(invite, 488, { headers: [INCOMPATIBLE_MEDIA] }))
  }

  function accepted(
    invite: SipRequest,
    transaction: string,
    sdp: Uint8Array,
    offered: boolean,
    now: number,
  ): CallOutput[] {
    const ok = createReply(invite, 200, { contact, sdp })
    pending = { repeat: repeatAnswer(transaction, ok, now, timers), offered, initial: false }
    // RFC 3261 §12.2.2: a 2xx to a target refresh moves the remote target to the new Contact
    dialog = { ...dialog, target: targetOf(invite) ?? dialog.target }
    return [respond(transaction, ok)]
  }

  // The app's answer settles the offer; its own offer waits for the answer in the ACK
  function answer(sdp: string, now: number): CallOutput[] {
    if (!asked || !media.use) return []
    const { invite, transaction, offering } = asked
    asked = undefined
    const ours = media.use(sdp, invite.body)
    const outputs = accepted(invite, transaction, ours, offering, now)
    return offering ? outputs : [...outputs, live()]
  }

  function changed(before: Shown | undefined): CallOutput[] {
    const after = media.shown("answer")
    if (!after.media || (before && sameShown(before, after))) return []
    return [live(after)]
  }

  // RFC 3264 §4: an offer in our 2xx is answered in the ACK; a new call without one hangs up
  function acknowledge(ack: SipRequest): CallOutput[] {
    if (!pending || ack.cseq.seq !== pending.repeat.seq || !inDialogOf(dialog, ack.to, ack.from)) {
      return []
    }
    const { offered, initial } = pending
    pending = undefined
    if (state === "ending") return hangUp()
    if (media.use) return settled(ack, offered, initial)
    const before = initial ? undefined : media.shown("answer")
    if (!offered || media.read(ack.body) || !initial) return changed(before)
    return incompatible()
  }

  function settled(ack: SipRequest, offered: boolean, initial: boolean): CallOutput[] {
    if (!offered) return initial ? [live()] : []
    if (media.read(ack.body)) return [live(media.shown("answer"))]
    return initial ? incompatible() : [live({ description: { type: "rollback" } })]
  }

  function incompatible(): CallOutput[] {
    state = "ending"
    closing = INCOMPATIBLE
    return hangUp()
  }

  // RFC 3261 §13.3.1.4 and §14.2: a 2xx that is never acknowledged ends the session with a BYE
  function expire(now: number): CallOutput[] {
    if (asked) return asked.until <= now ? withdraw(488) : []
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
      return earliest([pending?.repeat.deadline, asked?.until])
    },
    end,
    response,
    timeout,
    matches: (request) => inDialogOf(dialog, request.to, request.from),
    request,
    acknowledge,
    answer,
    expire,
  }
}

function branchOf(message: SipMessage): string | null | undefined {
  return topVia(message).params.get("branch")
}
