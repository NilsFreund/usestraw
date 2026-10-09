import { pad } from "./padding"
import { words64 } from "./words"

// FIPS 180-4 §4.2.3: SHA-384, SHA-512 and SHA-512/t constants
const K = words64(`
  428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538
  59f111f1b605d019 923f82a4af194f9b ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe
  243185be4ee4b28c 550c7dc3d5ffb4e2 72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235
  c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3 0fc19dc68b8cd5b5 240ca1cc77ac9c65
  2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 983e5152ee66dfab
  a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725
  06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed
  53380d139d95b3df 650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b
  a2bfe8a14cf10364 a81a664bbc423001 c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218
  d69906245565a910 f40e35855771202a 106aa07032bbd1b8 19a4c116b8d2d0c8 1e376c085141ab53
  2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb 5b9cca4f7763e373
  682e6ff3d6b2b8a3 748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec
  90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ca273eceea26619c
  d186b8c721c0c207 eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6
  113f9804bef90dae 1b710b35131c471b 28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc
  431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a 5fcb6fab3ad6faec 6c44198c4a475817
`)

// FIPS 180-4 §5.3.6.2: SHA-512/256 initial hash value
const INITIAL = `
  22312194fc2bf72c 9f555fa3c84c64c2 2393b86b6f53b151 963877195940eabd
  96283ee2a88effe3 be5e1e2553863992 2b0199fc2c85b8aa 0eb72ddc81c52ca2
`

const MASK = (1n << 64n) - 1n

// FIPS 180-4 §6.4 SHA-512 with the §6.7 SHA-512/256 truncation
export function sha512_256(bytes: Uint8Array): Uint8Array {
  const message = pad(bytes, 128, false)
  const hash = words64(INITIAL)
  const schedule = new DataView(new ArrayBuffer(640))
  for (let offset = 0; offset < message.byteLength; offset += 128) {
    for (let t = 0; t < 80; t++) {
      const word = t < 16 ? message.getBigUint64(offset + t * 8) : expand(schedule, t)
      schedule.setBigUint64(t * 8, word)
    }
    compress(hash, schedule)
  }
  return new Uint8Array(hash.buffer.slice(0, 32))
}

// FIPS 180-4 §6.4.2 step 1: message schedule with σ0 and σ1
function expand(schedule: DataView, t: number): bigint {
  const w2 = schedule.getBigUint64((t - 2) * 8)
  const w15 = schedule.getBigUint64((t - 15) * 8)
  const s0 = rotateRight(w15, 1n) ^ rotateRight(w15, 8n) ^ (w15 >> 7n)
  const s1 = rotateRight(w2, 19n) ^ rotateRight(w2, 61n) ^ (w2 >> 6n)
  return s1 + schedule.getBigUint64((t - 7) * 8) + s0 + schedule.getBigUint64((t - 16) * 8)
}

// FIPS 180-4 §6.4.2 steps 2–4: 80 rounds with Σ0, Σ1, Ch and Maj
function compress(hash: DataView, schedule: DataView): void {
  const read = (index: number) => hash.getBigUint64(index * 8)
  let [a, b, c, d, e, f, g, h] = [
    read(0),
    read(1),
    read(2),
    read(3),
    read(4),
    read(5),
    read(6),
    read(7),
  ]
  for (let t = 0; t < 80; t++) {
    const s1 = rotateRight(e, 14n) ^ rotateRight(e, 18n) ^ rotateRight(e, 41n)
    const choice = (e & f) ^ (~e & g)
    const t1 = h + s1 + choice + K.getBigUint64(t * 8) + schedule.getBigUint64(t * 8)
    const s0 = rotateRight(a, 28n) ^ rotateRight(a, 34n) ^ rotateRight(a, 39n)
    const t2 = s0 + ((a & b) ^ (a & c) ^ (b & c))
    ;[a, b, c, d, e, f, g, h] = [(t1 + t2) & MASK, a, b, c, (d + t1) & MASK, e, f, g]
  }
  for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) {
    hash.setBigUint64(index * 8, read(index) + value)
  }
}

function rotateRight(value: bigint, bits: bigint): bigint {
  return ((value >> bits) | (value << (64n - bits))) & MASK
}
