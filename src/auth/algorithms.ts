import { toHex } from "../support/hex"
import { md5 } from "../support/md5"
import { sha256 } from "../support/sha256"
import { sha512_256 } from "../support/sha512-256"

export interface Algorithm {
  readonly name: string
  readonly strength: number
  readonly session: boolean
  readonly hash: (data: Uint8Array) => string
}

// RFC 7616 §3.3 and RFC 8760 §2.1: "<algorithm>" and "<algorithm>-sess" from the IANA registry
const HASHES = new Map([
  ["MD5", { strength: 1, digest: md5 }],
  ["SHA-256", { strength: 2, digest: sha256 }],
  ["SHA-512-256", { strength: 3, digest: sha512_256 }],
])
const NAME = /^([A-Za-z0-9-]+?)(-sess)?$/i

export function findAlgorithm(name = "MD5"): Algorithm | undefined {
  const [, base = "", session] = NAME.exec(name) ?? []
  const canonical = base.toUpperCase()
  const known = HASHES.get(canonical)
  if (!known) return undefined
  const { strength, digest } = known
  return {
    name: canonical,
    strength,
    session: session !== undefined,
    hash: (data) => toHex(digest(data)),
  }
}
