import type { NameAddr } from "../../message/fields/name-addr"
import { createResponse } from "../../message/response"
import type { SipRequest, SipResponse } from "../../message/types"
import type { Address } from "../../transport/address"
import { createAuthenticator } from "../authenticator"
import { createTag } from "../ids"
import type { Identity } from "../requests"
import type { CallEnd, CallEvent, Credentials } from "../types"
import { reasonFor } from "./reasons"
import {
  createAck,
  createCancel,
  createDialog,
  createInvite,
  type Dialog,
  inDialog,
} from "./requests"

export type CallOutput =
  | { readonly type: "send"; readonly request: SipRequest; readonly to: Address }
  | { readonly type: "respond"; readonly transaction: string; readonly response: SipResponse }
  | { readonly type: "abandon"; readonly request: SipRequest }
  | { readonly type: "event"; readonly event: CallEvent }

export interface CallSetup {
  readonly call: string
  readonly uri: string
  readonly to: Address
  readonly sdp: Uint8Array
}

export interface Outgoing {
  readonly ended: boolean
  readonly deadline: number | undefined
  start(): CallOutput[]
  end(now: number): CallOutput[]
  response(response: SipResponse, now: number): CallOutput[]
  timeout(request: SipRequest): CallOutput[]
  matches(request: SipRequest): boolean
  request(request: SipRequest, transaction: string): CallOutput[]
  expire(now: number): CallOutput[]
}

const MAX_FORKS = 16

type State = "calling" | "ringing" | "live" | "ending" | "ended"

interface Confirmed {
  readonly dialog: Dialog
  readonly ack: SipRequest
}

export function createOutgoing(
  setup: CallSetup,
  identity: Identity,
  contact: NameAddr,
  credentials: Credentials | undefined,
  wait: number,
): Outgoing {
  const { call, uri, to, sdp } = setup
  const authenticator = createAuthenticator(credentials, identity.random)
  const from = { uri: identity.aor, params: new Map([["tag", createTag(identity.random)]]) }
  const forks = new Map<string, SipRequest>()
  let state: State = "calling"
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

  function send(request: SipRequest): CallOutput {
    return { type: "send", request, to }
  }

  function emit(event: CallEvent): CallOutput {
    return { type: "event", event }
  }

  function finish(ended: CallEnd): CallOutput[] {
    state = "ended"
    deadline = undefined
    return [emit({ type: "call", call, state: "ended", ended })]
  }

  function bye(target: Dialog): SipRequest {
    seq += 1
    const request = inDialog("BYE", target, seq, identity)
    return { ...request, headers: [...request.headers, ...authenticator.authorize(request)] }
  }

  function hungUp(): CallEnd {
    return { by: "local", reason: cancelWanted ? "cancelled" : "hangup" }
  }

  function isMain(tag: string | null | undefined): boolean {
    const remote = confirmed?.dialog.remote.params.get("tag") ?? ""
    return confirmed !== undefined && (tag ?? "") === remote
  }

  function start(): CallOutput[] {
    return [send(invite)]
  }

  // RFC 3261 §9.1: a CANCEL may only follow a provisional response, so an early end waits for one
  function end(now: number): CallOutput[] {
    if (state === "live" && confirmed) {
      state = "ending"
      return [send(bye(confirmed.dialog))]
    }
    if (state !== "calling" && state !== "ringing") return []
    cancelWanted = true
    return cancel(now)
  }

  // RFC 3261 §9.1: without a final response 64·T1 after the CANCEL, the INVITE counts as cancelled
  function cancel(now: number): CallOutput[] {
    if (!cancelWanted || cancelSent || !provisional) return []
    cancelSent = true
    deadline = now + wait
    return [send(createCancel(invite))]
  }

  function expire(now: number): CallOutput[] {
    if (deadline === undefined || deadline > now) return []
    return [{ type: "abandon", request: invite }, ...finish({ by: "local", reason: "cancelled" })]
  }

  function response(answer: SipResponse, now: number): CallOutput[] {
    if (answer.from.params.get("tag") !== from.params.get("tag")) return []
    const { method, seq: number } = answer.cseq
    if (method === "INVITE") return number === invite.cseq.seq ? inviteResponse(answer, now) : []
    const final = answer.status >= 200
    const ours = isMain(answer.to.params.get("tag"))
    if (method !== "BYE" || !final || state !== "ending" || !ours) return []
    const challenged = answer.status === 401 || answer.status === 407
    // RFC 3261 §22.2: a challenged BYE is sent again with credentials, or the far end keeps the call up
    if (!challenged || authenticator.challenge(answer)) return finish(hungUp())
    return [send(bye((confirmed as Confirmed).dialog))]
  }

  function inviteResponse(answer: SipResponse, now: number): CallOutput[] {
    if (answer.status < 200) return provisionalResponse(answer, now)
    if (answer.status < 300) return success(answer)
    return failure(answer)
  }

  function provisionalResponse(answer: SipResponse, now: number): CallOutput[] {
    provisional = true
    const outputs = cancel(now)
    if (answer.status === 100 || cancelWanted || (state !== "calling" && state !== "ringing")) {
      return outputs
    }
    state = "ringing"
    if (ringing && sameRinging(ringing, answer)) return outputs
    ringing = answer
    const media = answer.body.length > 0 ? { sdp: answer.body } : {}
    return [
      ...outputs,
      emit({ type: "call", call, state: "ringing", status: answer.status, ...media }),
    ]
  }

  // RFC 3261 §13.2.2.4: the first 2xx makes the dialog; every 2xx is acknowledged; other forks get a BYE
  function success(answer: SipResponse): CallOutput[] {
    const tag = answer.to.params.get("tag") ?? ""
    if (confirmed && isMain(tag)) return [send(confirmed.ack)]
    if (confirmed || state === "ended") return fork(answer, tag)
    const dialog = createDialog(invite, answer)
    confirmed = { dialog, ack: createAck(dialog, invite, identity) }
    if (cancelWanted) {
      state = "ending"
      return [send(confirmed.ack), send(bye(dialog))]
    }
    state = "live"
    const media = answer.body.length > 0 ? { sdp: answer.body } : {}
    return [send(confirmed.ack), emit({ type: "call", call, state: "live", ...media })]
  }

  function fork(answer: SipResponse, tag: string): CallOutput[] {
    const known = forks.get(tag)
    if (known) return [send(known)]
    if (forks.size >= MAX_FORKS) return []
    const other = createDialog(invite, answer)
    const acknowledgement = createAck(other, invite, identity)
    forks.set(tag, acknowledgement)
    return [send(acknowledgement), send(inDialog("BYE", other, invite.cseq.seq + 1, identity))]
  }

  function failure(answer: SipResponse): CallOutput[] {
    const { status } = answer
    if ((status === 401 || status === 407) && !cancelWanted) {
      if (authenticator.challenge(answer)) {
        return finish({ by: "remote", reason: "unauthorized", status })
      }
      seq += 1
      invite = build()
      provisional = false
      return [send(invite)]
    }
    if (cancelWanted) return finish({ by: "local", reason: "cancelled" })
    return finish({ by: "remote", reason: reasonFor(status), status })
  }

  function timeout(request: SipRequest): CallOutput[] {
    if (request.method === "INVITE" && request.cseq.seq === invite.cseq.seq) {
      return finish(
        cancelWanted ? { by: "local", reason: "cancelled" } : { by: "remote", reason: "timeout" },
      )
    }
    if (request.method === "BYE" && state === "ending" && isMain(request.to.params.get("tag"))) {
      return finish(hungUp())
    }
    return []
  }

  function matches(request: SipRequest): boolean {
    return (
      request.to.params.get("tag") === from.params.get("tag") &&
      isMain(request.from.params.get("tag"))
    )
  }

  // RFC 3261 §15.1.2: a BYE ends the dialog; once it is over, further requests get 481
  function request(incoming: SipRequest, transaction: string): CallOutput[] {
    const respond = (status: number, reason: string): CallOutput => ({
      type: "respond",
      transaction,
      response: createResponse(incoming, status, reason),
    })
    if (state === "ended") return [respond(481, "Call/Transaction Does Not Exist")]
    const ended = state === "ending" ? hungUp() : ({ by: "remote", reason: "hangup" } as const)
    return [respond(200, "OK"), ...finish(ended)]
  }

  return {
    get ended() {
      return state === "ended"
    },
    get deadline() {
      return deadline
    },
    start,
    end,
    response,
    timeout,
    matches,
    request,
    expire,
  }
}

function sameRinging(last: SipResponse, next: SipResponse): boolean {
  const [a, b] = [last.body, next.body]
  return (
    last.status === next.status &&
    last.to.params.get("tag") === next.to.params.get("tag") &&
    a.length === b.length &&
    a.every((byte, index) => byte === b[index])
  )
}
