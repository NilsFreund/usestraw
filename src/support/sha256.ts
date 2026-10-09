import { pad } from "./padding"
import { words32 } from "./words"

// FIPS 180-4 §4.2.2: SHA-224 and SHA-256 constants
const K = words32(`
  428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5
  d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174
  e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da
  983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967
  27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85
  a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070
  19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3
  748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2
`)

// FIPS 180-4 §5.3.3: initial hash value
const INITIAL = "6a09e667 bb67ae85 3c6ef372 a54ff53a 510e527f 9b05688c 1f83d9ab 5be0cd19"

// FIPS 180-4 §6.2 SHA-256
export function sha256(bytes: Uint8Array): Uint8Array {
  const message = pad(bytes, 64, false)
  const hash = words32(INITIAL)
  const schedule = new DataView(new ArrayBuffer(256))
  for (let offset = 0; offset < message.byteLength; offset += 64) {
    for (let t = 0; t < 64; t++) {
      schedule.setUint32(t * 4, t < 16 ? message.getUint32(offset + t * 4) : expand(schedule, t))
    }
    compress(hash, schedule)
  }
  return new Uint8Array(hash.buffer)
}

// FIPS 180-4 §6.2.2 step 1: message schedule with σ0 and σ1
function expand(schedule: DataView, t: number): number {
  const w2 = schedule.getUint32((t - 2) * 4)
  const w15 = schedule.getUint32((t - 15) * 4)
  const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3)
  const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10)
  return s1 + schedule.getUint32((t - 7) * 4) + s0 + schedule.getUint32((t - 16) * 4)
}

// FIPS 180-4 §6.2.2 steps 2–4: 64 rounds with Σ0, Σ1, Ch and Maj
function compress(hash: DataView, schedule: DataView): void {
  const read = (index: number) => hash.getUint32(index * 4)
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
  for (let t = 0; t < 64; t++) {
    const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
    const choice = (e & f) ^ (~e & g)
    const t1 = h + s1 + choice + K.getUint32(t * 4) + schedule.getUint32(t * 4)
    const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
    const t2 = s0 + ((a & b) ^ (a & c) ^ (b & c))
    ;[a, b, c, d, e, f, g, h] = [(t1 + t2) | 0, a, b, c, (d + t1) | 0, e, f, g]
  }
  for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) {
    hash.setUint32(index * 4, read(index) + value)
  }
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}
