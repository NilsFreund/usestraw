import type { RecordedStep } from "../recorder/recorder"
import type { CallMedia, MediaAddress } from "../sdp/types"
import type { TransportAddress } from "../transport/address"

export interface LinkHandlers {
  receive(data: Uint8Array, from: TransportAddress): void
  close(error?: Error): void
}

export interface Link {
  readonly local: TransportAddress
  readonly remote: TransportAddress
  readonly peers: readonly string[]
  start(handlers: LinkHandlers): void
  send(data: Uint8Array, to: TransportAddress): void
  close(): void
}

export interface CallAudio {
  readonly local: MediaAddress
  readonly sampleRate: number
  readonly played: number
  readonly readable: ReadableStream<Int16Array<ArrayBuffer>>
  readonly writable: WritableStream<Int16Array>
  update(media: CallMedia): void
  clear(): void
  close(): void
}

/** What a phone needs from where it runs: a server connection, audio per call, a debug log. */
export interface Platform {
  connect(signal: AbortSignal): Promise<Link>
  openAudio(host: string, silent: () => void): Promise<CallAudio>
  readonly debug?: ((step: RecordedStep) => void) | undefined
}
