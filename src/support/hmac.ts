import { sha256 } from "./sha256"

const BLOCK = 64

// RFC 2104 §2: H(K ^ opad || H(K ^ ipad || text)) with SHA-256
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK)
  block.set(key.length > BLOCK ? sha256(key) : key)
  const inner = sha256(
    concat(
      block.map((byte) => byte ^ 0x36),
      data,
    ),
  )
  return sha256(
    concat(
      block.map((byte) => byte ^ 0x5c),
      inner,
    ),
  )
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length)
  joined.set(first)
  joined.set(second, first.length)
  return joined
}
