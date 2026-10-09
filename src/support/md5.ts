import { pad } from "./padding"
import { words32 } from "./words"

// RFC 1321 §3.4: T[i] = floor(2^32 * abs(sin(i)))
const T = words32(`
  d76aa478 e8c7b756 242070db c1bdceee f57c0faf 4787c62a a8304613 fd469501
  698098d8 8b44f7af ffff5bb1 895cd7be 6b901122 fd987193 a679438e 49b40821
  f61e2562 c040b340 265e5a51 e9b6c7aa d62f105d 02441453 d8a1e681 e7d3fbc8
  21e1cde6 c33707d6 f4d50d87 455a14ed a9e3e905 fcefa3f8 676f02d9 8d2a4c8a
  fffa3942 8771f681 6d9d6122 fde5380c a4beea44 4bdecfa9 f6bb4b60 bebfbc70
  289b7ec6 eaa127fa d4ef3085 04881d05 d9d4d039 e6db99e5 1fa27cf8 c4ac5665
  f4292244 432aff97 ab9423a7 fc93a039 655b59c3 8f0ccc92 ffeff47d 85845dd1
  6fa87e4f fe2ce6e0 a3014314 4e0811a1 f7537e82 bd3af235 2ad7d2bb eb86d391
`)

// RFC 1321 §3.4: per-round shift amounts
const SHIFTS = new DataView(
  Uint8Array.of(
    ...[7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22],
    ...[5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20],
    ...[4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23],
    ...[6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21],
  ).buffer,
)

// RFC 1321 MD5, only for Digest authentication (RFC 7616)
export function md5(bytes: Uint8Array): Uint8Array {
  const message = pad(bytes, 64, true)
  let [h0, h1, h2, h3] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  for (let offset = 0; offset < message.byteLength; offset += 64) {
    let [a, b, c, d] = [h0, h1, h2, h3]
    for (let i = 0; i < 64; i++) {
      const [mixed, word] = round(i, b, c, d)
      const sum = a + mixed + T.getUint32(i * 4) + message.getUint32(offset + word * 4, true)
      ;[a, b, c, d] = [d, (b + rotateLeft(sum, SHIFTS.getUint8(i))) | 0, b, c]
    }
    ;[h0, h1, h2, h3] = [(h0 + a) | 0, (h1 + b) | 0, (h2 + c) | 0, (h3 + d) | 0]
  }
  const digest = new DataView(new ArrayBuffer(16))
  for (const [index, value] of [h0, h1, h2, h3].entries()) digest.setUint32(index * 4, value, true)
  return new Uint8Array(digest.buffer)
}

// RFC 1321 §3.4: F, G, H and I with the message word each round reads
function round(i: number, b: number, c: number, d: number): [mixed: number, word: number] {
  if (i < 16) return [(b & c) | (~b & d), i]
  if (i < 32) return [(d & b) | (~d & c), (5 * i + 1) % 16]
  if (i < 48) return [b ^ c ^ d, (3 * i + 5) % 16]
  return [c ^ (b | ~d), (7 * i) % 16]
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits))
}
