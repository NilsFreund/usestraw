import type { NameAddr } from "../../message/fields/name-addr"
import { getHeader } from "../../message/headers"
import type { SipRequest } from "../../message/types"
import { serverKey } from "../../transaction/keys"
import type { Address } from "../../transport/address"
import { createAuthenticator } from "../authenticator"
import { createTag } from "../ids"
import type { CallEnd, CallParty } from "../types"
import { emit, respond } from "./outputs"
import { reasonFor } from "./reasons"
import { repeatAnswer } from "./repeat"
import { createReply, createRetryLater } from "./replies"
import { createServerDialog, inDialogOf } from "./requests"
import { createSession, type Session } from "./session"
import type { Call, CallContext, CallOutput } from "./types"

export interface IncomingSetup {
  readonly invite: SipRequest
  readonly transaction: string
  readonly from: Address
}

// RFC 3261 §13.3.1.1: a ringing UAS repeats its provisional response every minute
const RING_REFRESH = 60_000
// Nobody rings longer than a proxy's Timer C would let them, or than the INVITE's Expires asks (§13.3.1)
const RING_LIMIT = 180_000

export function createIncoming(setup: IncomingSetup, context: CallContext, now: number): Call {
  const { invite, transaction, from: to } = setup
  const { identity, contact, credentials, timers } = context
  const call = invite.callId
  const tag = createTag(identity.random)
  const dialog = createServerDialog(invite, tag)
  const offer = invite.body.length > 0 ? { sdp: invite.body } : {}
  const ringing = createReply(invite, 180, { tag, contact, recordRoute: true })
  const expires = expiresOf(invite)
  const limited = expires !== undefined && expires < RING_LIMIT
  const giveUpAt = now + (limited ? expires : RING_LIMIT)
  let state: "ringing" | "ended" = "ringing"
  let session: Session | undefined
  let refreshAt = now + RING_REFRESH

  function reject(status: number, ended: CallEnd): CallOutput[] {
    if (state === "ended") return []
    state = "ended"
    const response = createReply(invite, status, { tag })
    return [respond(transaction, response), emit({ type: "call", call, state: "ended", ended })]
  }

  function start(): CallOutput[] {
    const parties = { from: party(invite.from), to: party(invite.to), source: to }
    const event = { type: "call", call, state: "incoming", ...parties, ...offer } as const
    return [respond(transaction, ringing), emit(event)]
  }

  function accept(sdp: Uint8Array, now: number): CallOutput[] {
    if (session || state === "ended") return []
    const ok = createReply(invite, 200, { tag, contact, sdp, recordRoute: true })
    const pending = repeatAnswer(transaction, ok, now, timers)
    const authenticator = createAuthenticator(credentials, identity.random)
    const remote = { remoteSeq: invite.cseq.seq, remoteSdp: invite.body }
    session = createSession(
      { call, dialog, to, seq: 0, sdp, pending, ...remote },
      { identity, contact, authenticator, timers },
    )
    return [respond(transaction, ok), emit({ type: "call", call, state: "live", ...offer })]
  }

  function end(_now: number, status = 486): CallOutput[] {
    if (session) return session.end()
    return reject(status, { by: "local", reason: reasonFor(status), status })
  }

  // RFC 3261 §9.2: a CANCEL gets 200, and while the INVITE it targets still rings, that INVITE gets 487
  function cancel(request: SipRequest, other: string): CallOutput[] {
    const ok = respond(other, createReply(request, 200, { tag }))
    const ringingInvite = !session && serverKey({ ...request, method: "INVITE" }) === transaction
    return ringingInvite ? [ok, ...reject(487, { by: "remote", reason: "cancelled" })] : [ok]
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
    merges: (request) =>
      request.from.params.get("tag") === invite.from.params.get("tag") &&
      request.cseq.seq === invite.cseq.seq,
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
