import type { NameAddr } from "../../message/fields/name-addr"
import { getHeader } from "../../message/headers"
import type { SipHeader, SipRequest } from "../../message/types"
import type { MediaAddress } from "../../sdp/types"
import { serverKey } from "../../transaction/keys"
import type { TransportAddress } from "../../transport/address"
import { createAuthenticator } from "../authenticator"
import { createTag } from "../ids"
import type { CallEnd, CallParty } from "../types"
import { createMedia } from "./media"
import { emit, respond } from "./outputs"
import { cancelReason, reasonFor } from "./reasons"
import { repeatAnswer } from "./repeat"
import { createReply, createRetryLater, INCOMPATIBLE_MEDIA } from "./replies"
import { createServerDialog, inDialogOf, repeats } from "./requests"
import { createSession, type Session } from "./session"
import type { CallContext, CallOutput, CallState } from "./types"

export interface IncomingSetup {
  readonly invite: SipRequest
  readonly transaction: string
  readonly from: TransportAddress
}

// RFC 3261 §13.3.1.1: a ringing UAS repeats its provisional response every minute
const RING_REFRESH = 60_000
// Nobody rings longer than a proxy's Timer C would let them, or than the INVITE's Expires asks (§13.3.1)
const RING_LIMIT = 180_000

export function createIncoming(setup: IncomingSetup, context: CallContext, now: number): CallState {
  const { invite, transaction, from: source } = setup
  const { identity, contact, credentials, trust, timers } = context
  const call = invite.callId
  const tag = createTag(identity.random)
  const dialog = createServerDialog(invite, tag)
  const ringing = createReply(invite, 180, { tag, contact, recordRoute: true })
  const expires = expiresOf(invite)
  const limited = expires !== undefined && expires < RING_LIMIT
  const giveUpAt = now + (limited ? expires : RING_LIMIT)
  let state: "ringing" | "ended" = "ringing"
  let session: Session | undefined
  let refreshAt = now + RING_REFRESH

  function reject(
    status: number,
    ended: CallEnd,
    headers: readonly SipHeader[] = [],
  ): CallOutput[] {
    if (state === "ended") return []
    state = "ended"
    const response = createReply(invite, status, { tag, headers })
    return [respond(transaction, response), emit({ type: "call", call, state: "ended", ended })]
  }

  function start(): CallOutput[] {
    const parties = { from: party(invite.from), to: party(invite.to), source }
    return [
      respond(transaction, ringing),
      emit({ type: "call", call, state: "incoming", ...parties }),
    ]
  }

  // RFC 3264 §4: we answer the offer in the INVITE, or offer in the 200 and read the answer from the ACK
  function accept(local: MediaAddress, now: number): CallOutput[] {
    if (session || state === "ended") return []
    const media = createMedia(local, identity.random)
    const offered = invite.body.length === 0
    const sdp = offered ? media.offer() : media.answer(invite.body)
    if (!sdp)
      return reject(488, { by: "local", reason: "incompatible", status: 488 }, [INCOMPATIBLE_MEDIA])
    const ok = createReply(invite, 200, { tag, contact, sdp, recordRoute: true })
    const pending = { repeat: repeatAnswer(transaction, ok, now, timers), offered }
    const authenticator = createAuthenticator(credentials, identity.random, trust)
    session = createSession(
      { call, dialog, to: source, seq: 0, remoteSeq: invite.cseq.seq, media, pending },
      { identity, contact, authenticator, timers },
    )
    return [respond(transaction, ok)]
  }

  function end(_now: number, status = 486): CallOutput[] {
    if (session) return session.end()
    return reject(status, { by: "local", reason: reasonFor(status), status })
  }

  // RFC 3261 §9.2: a CANCEL gets 200, and while the INVITE it targets still rings, that INVITE gets 487
  function cancel(request: SipRequest, other: string): CallOutput[] {
    const ok = respond(other, createReply(request, 200, { tag }))
    const ringingInvite = !session && serverKey({ ...request, method: "INVITE" }) === transaction
    if (!ringingInvite) return [ok]
    return [ok, ...reject(487, { by: "remote", reason: cancelReason(request) })]
  }

  // RFC 3261 §15.1.2: a BYE on the early dialog ends the pending INVITE with 487
  function request(incoming: SipRequest, other: string, now: number): CallOutput[] {
    if (incoming.method === "CANCEL") return cancel(incoming, other)
    if (session) return session.request(incoming, other, now)
    const reply = (status: number) => respond(other, createReply(incoming, status, { tag }))
    if (state === "ended") return [reply(481)]
    if (incoming.method === "BYE") {
      return [reply(200), ...reject(487, { by: "remote", reason: "cancelled" })]
    }
    return [respond(other, createRetryLater(incoming, identity.random))]
  }

  function expire(now: number): CallOutput[] {
    if (session) return session.expire(now)
    if (state === "ended" || Math.min(refreshAt, giveUpAt) > now) return []
    if (now >= giveUpAt && limited) return reject(487, { by: "remote", reason: "no-answer" })
    if (now >= giveUpAt) return reject(480, { by: "local", reason: "no-answer", status: 480 })
    refreshAt = now + RING_REFRESH
    return [respond(transaction, ringing)]
  }

  return {
    get ended() {
      return session ? session.ended : state === "ended"
    },
    get deadline() {
      if (session) return session.deadline
      return state === "ended" ? undefined : Math.min(refreshAt, giveUpAt)
    },
    start,
    accept,
    end,
    response: (response) => session?.response(response) ?? [],
    timeout: (request) => session?.timeout(request) ?? [],
    matches: (request) => inDialogOf(dialog, request.to, request.from),
    merges: (request) => repeats(invite, request),
    request,
    acknowledge: (ack) => session?.acknowledge(ack) ?? [],
    expire,
  }
}

function party({ uri, displayName }: NameAddr): CallParty {
  return displayName ? { uri, name: displayName } : { uri }
}

function expiresOf(invite: SipRequest): number | undefined {
  const value = getHeader(invite, "Expires")?.trim() ?? ""
  return /^\d{1,9}$/.test(value) ? Number(value) * 1000 : undefined
}
