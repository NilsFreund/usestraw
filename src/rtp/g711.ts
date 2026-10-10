import type { Codec } from "../sdp/types"

export const SAMPLES_PER_MS = 8

const BIAS = 0x84
const CLIP = 32_635

// ITU-T G.711: 16-bit linear PCM in, one byte per sample out
export function encodeG711(codec: Codec, pcm: Int16Array): Uint8Array {
  const encode = codec === "PCMU" ? encodeMulawSample : encodeAlawSample
  return Uint8Array.from(pcm, encode)
}

export function decodeG711(codec: Codec, payload: Uint8Array): Int16Array {
  return Int16Array.from(payload, codec === "PCMU" ? decodeMulawByte : decodeAlawByte)
}

function encodeMulawSample(value: number): number {
  const sign = value < 0 ? 0x80 : 0
  // ITU-T G.191: negative samples are taken in one's complement before the bias
  const magnitude = Math.min(value < 0 ? -value - 1 : value, CLIP) + BIAS
  const exponent = 31 - Math.clz32(magnitude) - 7
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

function decodeMulawByte(code: number): number {
  const value = ~code & 0xff
  const magnitude = ((((value & 0x0f) << 3) + BIAS) << ((value & 0x70) >> 4)) - BIAS
  return value & 0x80 ? -magnitude : magnitude
}

function encodeAlawSample(value: number): number {
  const linear = value >> 3
  const mask = linear >= 0 ? 0xd5 : 0x55
  const magnitude = linear >= 0 ? linear : -linear - 1
  const segment = Math.max(0, 27 - Math.clz32(magnitude))
  const bits = segment < 2 ? (magnitude >> 1) & 0x0f : (magnitude >> segment) & 0x0f
  return ((segment << 4) | bits) ^ mask
}

function decodeAlawByte(code: number): number {
  const value = code ^ 0x55
  const segment = (value & 0x70) >> 4
  const base = ((value & 0x0f) << 4) + (segment === 0 ? 8 : 0x108)
  const magnitude = segment > 1 ? base << (segment - 1) : base
  return value & 0x80 ? magnitude : -magnitude
}
