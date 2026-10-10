export interface RtpPacket {
  readonly marker: boolean
  readonly payloadType: number
  readonly sequence: number
  readonly timestamp: number
  readonly ssrc: number
  readonly payload: Uint8Array
}

const HEADER = 12

// RFC 3550 §5.1: version 2, no padding, no extension and no contributing sources on what we send
export function writeRtp(packet: RtpPacket): Uint8Array {
  const data = new Uint8Array(HEADER + packet.payload.length)
  const view = new DataView(data.buffer)
  view.setUint8(0, 0x80)
  view.setUint8(1, (packet.marker ? 0x80 : 0) | (packet.payloadType & 0x7f))
  view.setUint16(2, packet.sequence)
  view.setUint32(4, packet.timestamp)
  view.setUint32(8, packet.ssrc)
  data.set(packet.payload, HEADER)
  return data
}

// RFC 3550 §5.1 and §A.1: anything that is not a well-formed version 2 packet is dropped
export function readRtp(data: Uint8Array): RtpPacket | undefined {
  if (data.length < HEADER || data[0] === undefined || data[0] >> 6 !== 2) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const first = view.getUint8(0)
  const second = view.getUint8(1)
  let start = HEADER + (first & 0x0f) * 4
  if (first & 0x10) {
    if (data.length < start + 4) return undefined
    start += 4 + view.getUint16(start + 2) * 4
  }
  const padding = first & 0x20 ? view.getUint8(data.length - 1) : 0
  const end = data.length - padding
  if (start > end || (first & 0x20 && padding === 0)) return undefined
  return {
    marker: (second & 0x80) !== 0,
    payloadType: second & 0x7f,
    sequence: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: data.slice(start, end),
  }
}
