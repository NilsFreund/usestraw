import { formatHost } from "../message/fields/via"
import type { SipRequest } from "../message/types"
import type { Address } from "../transport/address"
import { createBranch, createCallId, createTag } from "./ids"
import type { Random } from "./types"

export interface Identity {
  readonly address: Address
  readonly aor: string
  readonly random: Random
}

export function createOptionsRequest(uri: string, identity: Identity): SipRequest {
  const { address, aor, random } = identity
  return {
    method: "OPTIONS",
    uri,
    via: [
      {
        transport: address.transport,
        host: formatHost(address.host),
        port: address.port,
        params: new Map([
          ["branch", createBranch(random)],
          ["rport", null],
        ]),
      },
    ],
    maxForwards: 70,
    from: { uri: aor, params: new Map([["tag", createTag(random)]]) },
    to: { uri, params: new Map() },
    callId: createCallId(random),
    cseq: { seq: 1, method: "OPTIONS" },
    contact: [],
    headers: [],
    body: new Uint8Array(),
  }
}
