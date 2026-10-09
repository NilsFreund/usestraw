import type { NameAddr } from "../../message/fields/name-addr"
import type { SipRequest } from "../../message/types"
import { createCallId, createTag } from "../ids"
import { createRequest, type Identity } from "../requests"
import { createContact } from "./binding"

export interface Registrant {
  readonly from: NameAddr
  readonly to: NameAddr
  readonly callId: string
  readonly contact: NameAddr
}

// RFC 3261 §10.2: one Call-ID for all registrations to a registrar, CSeq rising by one
export function createRegistrant(identity: Identity): Registrant {
  const { address, aor, random } = identity
  return {
    from: { uri: aor, params: new Map([["tag", createTag(random)]]) },
    to: { uri: aor, params: new Map() },
    callId: createCallId(random),
    contact: createContact(address, aor),
  }
}

// RFC 3327 §5.1: Supported: path lets edge proxies add Path headers
export function createRegisterRequest(
  registrant: Registrant,
  registrar: string,
  seq: number,
  expires: number,
  identity: Identity,
): SipRequest {
  const { from, to, callId, contact } = registrant
  const headers = [
    { name: "Expires", value: String(expires) },
    { name: "Supported", value: "path" },
  ]
  return createRequest(
    "REGISTER",
    registrar,
    { from, to, callId, seq, contact: [contact], headers },
    identity,
  )
}
