// RFC 1321 §3.1–3.2 and FIPS 180-4 §5.1: append 0x80, zeros and the bit length
export function pad(bytes: Uint8Array, blockSize: 64 | 128, littleEndian: boolean): DataView {
  const size = Math.ceil((bytes.length + 1 + blockSize / 8) / blockSize) * blockSize
  const padded = new Uint8Array(size)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setBigUint64(size - 8, BigInt(bytes.length) * 8n, littleEndian)
  return view
}
