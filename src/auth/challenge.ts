import { splitList } from "../message/syntax"
import { parseAuthParams } from "./params"

export interface Challenge {
  readonly realm: string
  readonly nonce: string
  readonly algorithm?: string
  readonly qop: readonly string[]
  readonly opaque?: string
  readonly stale: boolean
  readonly userhash: boolean
}

const DIGEST = /^Digest[ \t]+(.+)$/is
const MAX_VALUE = 1024

// RFC 7616 §3.3 challenge as carried by WWW-Authenticate and Proxy-Authenticate (RFC 3261 §20.44)
export function parseChallenge(value: string): Challenge | undefined {
  const [, rest] = DIGEST.exec(value) ?? []
  const params = rest === undefined ? undefined : parseAuthParams(rest)
  const realm = params?.get("realm")
  const nonce = params?.get("nonce")
  if (!params || realm === undefined || nonce === undefined) return undefined
  const algorithm = params.get("algorithm")
  const opaque = params.get("opaque")
  if ([realm, nonce, opaque ?? ""].some((text) => text.length > MAX_VALUE)) return undefined
  return {
    realm,
    nonce,
    ...(algorithm === undefined ? {} : { algorithm }),
    qop: splitList(params.get("qop") ?? "").map((qop) => qop.toLowerCase()),
    ...(opaque === undefined ? {} : { opaque }),
    stale: params.get("stale")?.toLowerCase() === "true",
    userhash: params.get("userhash")?.toLowerCase() === "true",
  }
}
