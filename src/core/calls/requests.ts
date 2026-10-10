import { formatNameAddr, type NameAddr, parseNameAddr } from "../../message/fields/name-addr"
import { isRequestUri } from "../../message/fields/uri"
import { getHeaders } from "../../message/headers"
import { splitOutside } from "../../message/syntax"
import type { SipHeader, SipRequest, SipResponse } from "../../message/types"
import { ALLOW, createRequest, type Identity } from "../requests"

export interface Dialog {
  readonly callId: string
  readonly local: NameAddr
  readonly remote: NameAddr
  readonly target: string
  readonly routes: readonly NameAddr[]
}

export interface InviteFields {
  readonly callId: string
  readonly from: NameAddr
  readonly uri: string
  readonly seq: number
  readonly contact: NameAddr
  readonly sdp: Uint8Array
}

export const SDP: SipHeader = { name: "Content-Type", value: "application/sdp" }
const CREDENTIALS = /^(?:proxy-)?authorization$/i
const MAX_ROUTES = 32

export function createInvite(fields: InviteFields, identity: Identity): SipRequest {
  const { callId, from, uri, seq, contact, sdp } = fields
  const to = { uri, params: new Map() }
  const request = { from, to, callId, seq, contact: [contact], headers: [ALLOW, SDP] }
  return { ...createRequest("INVITE", uri, request, identity), body: sdp }
}

// RFC 3261 §9.1: CANCEL copies the INVITE's Request-URI, Via, From, To, Call-ID and CSeq number
export function createCancel(invite: SipRequest): SipRequest {
  return {
    method: "CANCEL",
    uri: invite.uri,
    via: invite.via,
    maxForwards: 70,
    from: invite.from,
    to: invite.to,
    callId: invite.callId,
    cseq: { seq: invite.cseq.seq, method: "CANCEL" },
    contact: [],
    headers: [],
    body: new Uint8Array(),
  }
}

// RFC 3261 §12.1.2: the UAC takes the route set from Record-Route in reverse and the target from Contact
export function createDialog(invite: SipRequest, response: SipResponse): Dialog {
  return {
    callId: invite.callId,
    local: invite.from,
    remote: response.to,
    target: targetOf(response) ?? invite.uri,
    routes: routesOf(response).reverse(),
  }
}

// RFC 3261 §12.1.1: the UAS keeps Record-Route in order and targets the Contact of the INVITE
export function createServerDialog(invite: SipRequest, tag: string): Dialog {
  return {
    callId: invite.callId,
    local: { ...invite.to, params: new Map([...invite.to.params, ["tag", tag]]) },
    remote: invite.from,
    target: targetOf(invite) ?? invite.from.uri,
    routes: routesOf(invite),
  }
}

// A Contact or route that could not be sent on is ignored, and an absurdly long route set is dropped
export function targetOf(message: SipRequest | SipResponse): string | undefined {
  const contact = message.contact === "*" ? undefined : message.contact[0]
  return contact && isRequestUri(contact.uri) ? contact.uri : undefined
}

function routesOf(message: SipRequest | SipResponse): NameAddr[] {
  const recorded = getHeaders(message, "Record-Route").flatMap(parseRoutes)
  const usable = recorded.every((route) => isRequestUri(route.uri)) && recorded.length <= MAX_ROUTES
  return usable ? recorded : []
}

// RFC 3261 §12.2.2: a message belongs to the dialog by its local and remote tag
export function inDialogOf(dialog: Dialog, local: NameAddr, remote: NameAddr): boolean {
  return (
    local.params.get("tag") === dialog.local.params.get("tag") &&
    remote.params.get("tag") === dialog.remote.params.get("tag")
  )
}

// RFC 3261 §13.2.2.4: the ACK for a 2xx keeps the INVITE's CSeq number and credentials
export function createAck(dialog: Dialog, invite: SipRequest, identity: Identity): SipRequest {
  const credentials = invite.headers.filter((header) => CREDENTIALS.test(header.name))
  return inDialog("ACK", dialog, invite.cseq.seq, identity, credentials)
}

// RFC 3261 §12.2.1.1: requests in a dialog go to the remote target along the route set
export function inDialog(
  method: string,
  dialog: Dialog,
  seq: number,
  identity: Identity,
  extra: readonly SipHeader[] = [],
): SipRequest {
  const routes = dialog.routes.map((route) => ({ name: "Route", value: formatNameAddr(route) }))
  const fields = {
    from: dialog.local,
    to: dialog.remote,
    callId: dialog.callId,
    seq,
    headers: [...routes, ...extra],
  }
  return createRequest(method, dialog.target, fields, identity)
}

function parseRoutes(value: string): NameAddr[] {
  try {
    return splitOutside(value, ",").map(parseNameAddr)
  } catch {
    return []
  }
}
