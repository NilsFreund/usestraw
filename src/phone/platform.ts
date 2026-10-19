import type { RemoteDescription } from "../core/types"
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

interface AudioStreams {
  readonly sampleRate: number
  readonly played: number
  readonly readable: ReadableStream<Int16Array<ArrayBuffer>>
  readonly writable: WritableStream<Int16Array>
  clear(): void
  close(): void
}

/** A call's audio over plain RTP: the core writes G.711 SDP for `local` and reports what it agreed. */
export interface RtpAudio extends AudioStreams {
  readonly local: MediaAddress
  update(media: CallMedia): void
}

/** A call's audio that makes its own SDP, as WebRTC does: the core carries it and reports the far end's. */
export interface SdpAudio extends AudioStreams {
  // An offer without `remote`, else the answer to it
  describe(remote?: RemoteDescription): Promise<string>
  apply(remote: RemoteDescription): Promise<void>
  // The call is live: what the platform heard before was ringing, not the call
  live(): void
}

export type CallAudio = RtpAudio | SdpAudio

// An agent talks instead of the user, so a browser leaves the microphone alone
export interface AudioOptions {
  readonly microphone: boolean
}

/** What a phone needs from where it runs: a server connection, audio per call, a debug log. */
export interface Platform {
  connect(signal: AbortSignal): Promise<Link>
  openAudio(host: string, silent: () => void, options: AudioOptions): Promise<CallAudio>
  readonly debug?: ((step: RecordedStep) => void) | undefined
  // Set where calls make their own SDP, as in browsers
  readonly media?: "sdp" | undefined
  // An RFC 5626 instance id that outlives the page, so a reload replaces its own registration
  readonly instance?: string | undefined
}
