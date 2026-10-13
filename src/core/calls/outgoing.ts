import type { SipRequest, SipResponse } from "../../message/types"
import { sameBytes } from "../../support/bytes"
import { transactionTimeout } from "../../transaction/timers"
import type { TransportAddress } from "../../transport/address"
import { createAuthenticator } from "../authenticator"
import { createTag } from "../ids"
import type { CallEnd } from "../types"
import { type MediaSetup, mediaFor } from "./media"
import { emit, respond, send } from "./outputs"
import { reasonFor } from "./reasons"
import { createReply } from "./replies"
import {
  createCancel,
  createDialog,
  createDialogAck,
  createInvite,
  inDialog,
  repeats,
} from "./requests"
import { createSession, INCOMPATIBLE, type Session } from "./session"
import type { CallContext, CallOutput, CallState } from "./types"

export interface OutgoingSetup {
  readonly call: string
  readonly uri: string
  readonly to: TransportAddress
  readonly media: MediaSetup
}

interface Confirmed {
  readonly session: Session
  readonly ack: SipRequest
  readonly tag: string
}

const MAX_FORKS = 16
const CANCELLED: CallEnd = { by: "local", reason: "cancelled" }

export function createOutgoing(setup: OutgoingSetup, context: CallContext): CallState {
  const { call, uri, to } = setup
  const { identity, contact, credentials, trust, timers } = context
  const authenticator = createAuthenticator(credentials, identity.random, trust)
  const ours = createTag(identity.random)
  const from = { uri: identity.aor, params: new Map([["tag", ours]]) }
  const media = mediaFor(setup.media, identity.random)
  const sdp = media.offer()
  const forks = new Map<string, SipRequest>()
  const early = new Map<string, Uint8Array>()
  let state: "calling" | "ringing" | "confirmed" | "ended" = "calling"
  let seq = 1
  let invite = build()
  let provisional = false
  let cancelWanted = false
  let cancelSent = false
  let ringing: SipResponse | undefined
  let confirmed: Confirmed | undefined
  let deadline: number | undefined

  function build(): SipRequest {
    const request = createInvite({ callId: call, from, uri, seq, contact, sdp }, identity)
    return { ...request, headers: [...request.headers, ...authenticator.authorize(request)] }
  }

  function finish(ended: CallEnd): CallOutput[] {
    state = "ended"
    deadline = undefined
    return [emit({ type: "call", call, state: "ended", ended })]
  }

  // RFC 3261 §9.1: a CANCEL may only follow a provisional response, so an early end waits for one
  function end(now: number): CallOutput[] {
    if (confirmed) return confirmed.session.end()
    if (state !== "calling" && state !== "ringing") return []
    cancelWanted = true
    return cancel(now)
  }

  // RFC 3261 §9.1: without a final response 64·T1 after the CANCEL, the INVITE counts as cancelled
  function cancel(now: number): CallOutput[] {
    if (!cancelWanted || cancelSent || !provisional) return []
    cancelSent = true
    deadline = now + transactionTimeout(timers)
    return [send(createCancel(invite), to)]
  }

  function expire(now: number): CallOutput[] {
    if (confirmed) return confirmed.session.expire(now)
    if (deadline === undefined || deadline > now) return []
    return [{ type: "abandon", request: invite }, ...finish(CANCELLED)]
  }

  function response(reply: SipResponse, now: number): CallOutput[] {
    if (reply.from.params.get("tag") !== from.params.get("tag")) return []
    const { method, seq: number } = reply.cseq
    if (method === "INVITE") return number === invite.cseq.seq ? inviteResponse(reply, now) : []
    return confirmed ? confirmed.session.response(reply) : []
  }

  function inviteResponse(reply: SipResponse, now: number): CallOutput[] {
    if (reply.status < 200) return provisionalResponse(reply, now)
    if (reply.status < 300) return success(reply)
    return failure(reply)
  }

  function provisionalResponse(reply: SipResponse, now: number): CallOutput[] {
    provisional = true
    const outputs = cancel(now)
    if (reply.status === 100 || cancelWanted || (state !== "calling" && state !== "ringing")) {
      return outputs
    }
    state = "ringing"
    const tag = reply.to.params.get("tag") ?? ""
    if (reply.body.length > 0 && (early.has(tag) || early.size < MAX_FORKS)) {
      early.set(tag, reply.body)
    }
    if (ringing && sameRinging(ringing, reply)) return outputs
    ringing = reply
    const preview = reply.body.length > 0 && media.read(reply.body)
    return [
      ...outputs,
      emit({
        type: "call",
        call,
        state: "ringing",
        status: reply.status,
        ...(preview ? media.shown("pranswer") : {}),
      }),
    ]
  }

  // RFC 3261 §13.2.2.4: the first 2xx makes the dialog; every 2xx is acknowledged; other forks get a BYE
  function success(reply: SipResponse): CallOutput[] {
    const tag = reply.to.params.get("tag") ?? ""
    if (confirmed?.tag === tag) return [send(confirmed.ack, to)]
    if (confirmed || state === "ended") return fork(reply, tag)
    const dialog = createDialog(invite, reply)
    const ack = createDialogAck(dialog, invite, identity)
    const session = createSession(
      { call, tag: ours, dialog, to, seq, media },
      { identity, contact, authenticator, timers },
    )
    confirmed = { session, ack, tag }
    state = "confirmed"
    if (cancelWanted) return [send(ack, to), ...session.end(CANCELLED)]
    // RFC 3264 §5: the answer in the 2xx decides; without one we keep what this fork's early media said
    const answer = reply.body.length > 0 ? reply.body : early.get(tag)
    const answered = answer !== undefined && media.read(answer)
    if (!answered) return [send(ack, to), ...session.end(INCOMPATIBLE)]
    return [send(ack, to), emit({ type: "call", call, state: "live", ...media.shown("answer") })]
  }

  function fork(reply: SipResponse, tag: string): CallOutput[] {
    const known = forks.get(tag)
    if (known) return [send(known, to)]
    if (forks.size >= MAX_FORKS) return []
    const other = createDialog(invite, reply)
    const acknowledgement = createDialogAck(other, invite, identity)
    forks.set(tag, acknowledgement)
    return [
      send(acknowledgement, to),
      send(inDialog("BYE", other, invite.cseq.seq + 1, identity), to),
    ]
  }

  function failure(reply: SipResponse): CallOutput[] {
    const { status } = reply
    if ((status === 401 || status === 407) && !cancelWanted) {
      if (authenticator.challenge(reply)) {
        return finish({ by: "remote", reason: "unauthorized", status })
      }
      seq += 1
      invite = build()
      provisional = false
      return [send(invite, to)]
    }
    if (cancelWanted) return finish(CANCELLED)
    return finish({ by: "remote", reason: reasonFor(status), status })
  }

  function timeout(request: SipRequest): CallOutput[] {
    if (confirmed) return confirmed.session.timeout(request)
    if (request.method !== "INVITE" || request.cseq.seq !== invite.cseq.seq) return []
    return finish(cancelWanted ? CANCELLED : { by: "remote", reason: "dropped" })
  }

  function request(incoming: SipRequest, transaction: string, now: number): CallOutput[] {
    if (confirmed) return confirmed.session.request(incoming, transaction, now)
    return [respond(transaction, createReply(incoming, 481))]
  }

  return {
    get ended() {
      return confirmed ? confirmed.session.ended : state === "ended"
    },
    get deadline() {
      return confirmed ? confirmed.session.deadline : deadline
    },
    start: () => [send(invite, to)],
    accept: () => [],
    end,
    response,
    timeout,
    matches: (request) => confirmed?.session.matches(request) ?? false,
    merges: (request) => repeats(invite, request),
    request,
    acknowledge: (ack) => confirmed?.session.acknowledge(ack) ?? [],
    answer: (sdp, now) => confirmed?.session.answer(sdp, now) ?? [],
    expire,
  }
}

function sameRinging(last: SipResponse, next: SipResponse): boolean {
  return (
    last.status === next.status &&
    last.to.params.get("tag") === next.to.params.get("tag") &&
    sameBytes(last.body, next.body)
  )
}
