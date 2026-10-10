export type MediaDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive"

export type Codec = "PCMU" | "PCMA"

export interface MediaAddress {
  readonly host: string
  readonly port: number
}

export interface CallMedia {
  readonly remote: MediaAddress
  readonly codec: Codec
  readonly payloadType: number
  readonly dtmf?: number
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
  readonly fmtp: ReadonlyMap<number, string>
  readonly ptime?: number
}

export interface SessionDescription {
  readonly origin: string
  readonly connection?: Connection
  readonly direction?: MediaDirection
  readonly media: readonly MediaDescription[]
}
