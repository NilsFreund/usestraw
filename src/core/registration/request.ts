import type { NameAddr } from "../../message/fields/name-addr"
import type { SipRequest } from "../../message/types"
import { isWebSocket } from "../../transport/address"
import { createCallId, createInstanceId, createTag } from "../ids"
import { createRequest, type Identity } from "../requests"
import { createContact } from "./binding"

export interface Registrant {
  readonly from: NameAddr
  readonly to: NameAddr
  readonly callId: string
  readonly contact: NameAddr
  readonly instance?: string | undefined
}

// RFC 3261 §10.2: one Call-ID for all registrations to a registrar, CSeq rising by one
export function createRegistrant(identity: Identity): Registrant {
  const { address, aor, random } = identity
  return {
    from: { uri: aor, params: new Map([["tag", createTag(random)]]) },
    to: { uri: aor, params: new Map() },
    callId: createCallId(random),
    contact: createContact(address, aor),
    instance: isWebSocket(address.transport) ? createInstanceId(random) : undefined,
  }
}

// RFC 3327 §5.1: Supported: path lets edge proxies add Path headers; RFC 5626 §4.2: outbound flows
export function createRegisterRequest(
  registrant: Registrant,
  registrar: string,
  seq: number,
  expires: number,
  identity: Identity,
  stale?: NameAddr,
): SipRequest {
  const { from, to, callId, instance } = registrant
  const removed = stale && { ...stale, params: new Map([...stale.params, ["expires", "0"]]) }
  const current =
    instance === undefined ? registrant.contact : withInstance(registrant.contact, instance)
  const contact = removed ? [current, removed] : [current]
  const headers = [
    { name: "Expires", value: String(expires) },
    { name: "Supported", value: instance === undefined ? "path" : "path, outbound" },
  ]
  return createRequest("REGISTER", registrar, { from, to, callId, seq, contact, headers }, identity)
}

function withInstance(contact: NameAddr, instance: string): NameAddr {
  const params = new Map([...contact.params, ["reg-id", "1"], ["+sip.instance", `"<${instance}>"`]])
  return { ...contact, params }
}
