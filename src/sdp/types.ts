/** RFC 3264 §5.1: which way audio flows on a media line. */
export type MediaDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive"

/** G.711 μ-law or A-law. */
export type Codec = "PCMU" | "PCMA"

/** Where RTP goes: an IP address and port. */
export interface MediaAddress {
  readonly host: string
  readonly port: number
}

/** What a call's SDP agreed on: where to send, which codec and payload type, ptime and direction. */
export interface CallMedia {
  readonly remote: MediaAddress
  readonly codec: Codec
  readonly payloadType: number
  readonly ptime: number
  readonly direction: MediaDirection
}

export interface Connection {
  readonly family: string
  readonly address: string
}

export interface RtpMap {
  readonly name: string
  readonly rate: number
  readonly channels?: number
}

export interface MediaDescription {
  readonly kind: string
  readonly port: number
  readonly protocol: string
  readonly formats: readonly string[]
  readonly connection?: Connection
  readonly direction?: MediaDirection
  readonly rtpmap: ReadonlyMap<number, RtpMap>
  readonly ptime?: number
}

export interface SessionDescription {
  readonly origin: string
  readonly connection?: Connection
  readonly direction?: MediaDirection
  readonly media: readonly MediaDescription[]
}
