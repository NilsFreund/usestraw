import type { Contact } from "../message/fields/contact"
import { formatHost } from "../message/fields/host"
import type { NameAddr } from "../message/fields/name-addr"
import type { Via } from "../message/fields/via"
import type { Header, SipRequest } from "../message/types"
import type { Address } from "../transport/address"
import { createBranch, createCallId, createTag } from "./ids"
import type { Random } from "./types"

export interface Identity {
  readonly address: Address
  readonly aor: string
  readonly random: Random
}

export interface RequestFields {
  readonly from: NameAddr
  readonly to: NameAddr
  readonly callId: string
  readonly seq: number
  readonly contact?: Contact
  readonly headers?: readonly Header[]
}

export function createRequest(
  method: string,
  uri: string,
  fields: RequestFields,
  identity: Identity,
): SipRequest {
  const { from, to, callId, seq, contact = [], headers = [] } = fields
  return {
    method,
    uri,
    via: [createVia(identity.address, identity.random)],
    maxForwards: 70,
    from,
    to,
    callId,
    cseq: { seq, method },
    contact,
    headers,
    body: new Uint8Array(),
  }
}

export function createOptionsRequest(uri: string, identity: Identity, callId?: string): SipRequest {
  const { aor, random } = identity
  const from = { uri: aor, params: new Map([["tag", createTag(random)]]) }
  const to = { uri, params: new Map() }
  const fields = { from, to, callId: callId ?? createCallId(random), seq: 1 }
  return createRequest("OPTIONS", uri, fields, identity)
}

function createVia(address: Address, random: Random): Via {
  return {
    transport: address.transport,
    host: formatHost(address.host),
    port: address.port,
    params: new Map([
      ["branch", createBranch(random)],
      ["rport", null],
    ]),
  }
}
