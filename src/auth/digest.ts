import { show } from "../message/syntax"
import type { SipRequest } from "../message/types"
import { isIntegerIn } from "../support/integer"
import type { Offer, Qop } from "./offer"

export interface Secret {
  readonly username: string
  readonly password: string
}

export type DigestTarget = Pick<SipRequest, "method" | "uri" | "body">

export interface ClientNonce {
  readonly cnonce: string
  readonly nc: number
}

export interface Authorization {
  readonly username: string
  readonly realm: string
  readonly nonce: string
  readonly uri: string
  readonly response: string
  readonly algorithm?: string
  readonly opaque?: string
  readonly protection?: { readonly qop: Qop; readonly nc: string; readonly cnonce: string }
  readonly userhash: boolean
}

const CNONCE = /^[!#-[\]-~]+$/
const encoder = new TextEncoder()

export function computeAuthorization(
  offer: Offer,
  secret: Secret,
  target: DigestTarget,
  client: ClientNonce,
): Authorization {
  const { challenge, algorithm, qop } = offer
  const { realm, nonce, opaque } = challenge
  if (!isIntegerIn(client.nc, 1, 0xffffffff)) {
    throw new RangeError(`Invalid nonce count ${client.nc}`)
  }
  if (!CNONCE.test(client.cnonce)) throw new TypeError(`Invalid cnonce ${show(client.cnonce)}`)
  const hash = (text: string) => algorithm.hash(encoder.encode(text))
  const nc = client.nc.toString(16).padStart(8, "0")
  // RFC 7616 §3.4.2: A1, turned into a session key for -sess
  const secretHash = hash(`${secret.username}:${realm}:${secret.password}`)
  const ha1 = algorithm.session ? hash(`${secretHash}:${nonce}:${client.cnonce}`) : secretHash
  // RFC 7616 §3.4.3: A2, with H(entity-body) for auth-int (RFC 8760 §2.6 item 7)
  const bodyHash = qop === "auth-int" ? `:${algorithm.hash(target.body)}` : ""
  const ha2 = hash(`${target.method}:${target.uri}${bodyHash}`)
  // RFC 7616 §3.4.1 response, or RFC 2069 §2.1.2 when the server sent no qop
  const proof = qop === undefined ? nonce : `${nonce}:${nc}:${client.cnonce}:${qop}`
  return {
    // RFC 7616 §3.4.4: username hashing
    username: challenge.userhash ? hash(`${secret.username}:${realm}`) : secret.username,
    realm,
    nonce,
    uri: target.uri,
    response: hash(`${ha1}:${proof}:${ha2}`),
    ...(challenge.algorithm === undefined ? {} : { algorithm: challenge.algorithm }),
    ...(opaque === undefined ? {} : { opaque }),
    ...(qop === undefined ? {} : { protection: { qop, nc, cnonce: client.cnonce } }),
    userhash: challenge.userhash,
  }
}
