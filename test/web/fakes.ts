import type { Player, WebMedia } from "../../src/web/peer"

// Just enough of the browser's WebRTC objects for the platform to run in Node

export class FakeTrack {
  stopped = false
  readonly kind: string
  constructor(kind = "audio") {
    this.kind = kind
  }
  stop(): void {
    this.stopped = true
  }
}

export class FakeTransceiver {
  readonly receiver: { readonly track: FakeTrack }
  stopped = false
  constructor(kind: string) {
    this.receiver = { track: new FakeTrack(kind) }
  }
  stop(): void {
    this.stopped = true
  }
}

export class FakeStream {
  readonly tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }
  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

export class FakePeer extends EventTarget {
  static last: FakePeer | undefined
  readonly configuration: RTCConfiguration
  readonly added: [FakeTrack, FakeStream][] = []
  readonly calls: string[] = []
  readonly transceivers: FakeTransceiver[] = []
  iceGatheringState: RTCIceGatheringState = "new"
  signalingState: RTCSignalingState = "stable"
  connectionState: RTCPeerConnectionState = "new"
  localDescription: { type: string; sdp: string } | null = null
  // Gathering finishes right after the local description unless a test holds it back
  gathers = true
  failRemote = false

  constructor(configuration: RTCConfiguration) {
    super()
    this.configuration = configuration
    FakePeer.last = this
  }

  addTrack(track: FakeTrack, stream: FakeStream): void {
    this.added.push([track, stream])
  }

  getTransceivers(): FakeTransceiver[] {
    return this.transceivers
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push(`remote ${description.type}`)
    this.open()
    if (this.failRemote) throw new DOMException("bad SDP", "InvalidAccessError")
    if (description.type === "rollback") this.rollback()
    if (description.type === "offer") this.signalingState = "have-remote-offer"
    else if (description.type === "pranswer") this.signalingState = "have-remote-pranswer"
    else this.signalingState = "stable"
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push(`local ${description?.type ?? "implicit"}`)
    this.open()
    if (description?.type === "rollback") {
      this.rollback()
      this.signalingState = "stable"
      return
    }
    const answering = this.signalingState === "have-remote-offer"
    this.signalingState = answering ? "stable" : "have-local-offer"
    this.localDescription = { type: answering ? "answer" : "offer", sdp: "v=0\r\nlocal\r\n" }
    if (!this.gathers) return
    queueMicrotask(() => this.gather())
  }

  gather(): void {
    this.iceGatheringState = "complete"
    this.dispatchEvent(new Event("icegatheringstatechange"))
  }

  connection(state: RTCPeerConnectionState): void {
    this.connectionState = state
    this.dispatchEvent(new Event("connectionstatechange"))
  }

  track(streams: FakeStream[], track: FakeTrack = new FakeTrack()): void {
    this.dispatchEvent(Object.assign(new Event("track"), { streams, track }))
  }

  close(): void {
    this.calls.push("close")
    this.signalingState = "closed"
  }

  // As in the browser: a closed connection refuses everything, and a pranswer can't be rolled back
  private open(): void {
    if (this.signalingState === "closed") throw new DOMException("closed", "InvalidStateError")
  }

  private rollback(): void {
    if (this.signalingState === "stable" || this.signalingState === "have-remote-pranswer") {
      throw new DOMException("nothing to roll back", "InvalidStateError")
    }
  }
}

export interface FakeMedia extends WebMedia {
  readonly players: FakePlayer[]
  readonly asked: MediaStreamConstraints[]
  readonly microphone: FakeStream
}

export interface FakePlayer extends Player {
  played: number
}

export function fakeMedia({ refuse }: { refuse?: DOMException } = {}): FakeMedia {
  const players: FakePlayer[] = []
  const asked: MediaStreamConstraints[] = []
  const microphone = new FakeStream()
  return {
    players,
    asked,
    microphone,
    RTCPeerConnection: FakePeer as unknown as WebMedia["RTCPeerConnection"],
    MediaStream: FakeStream as unknown as WebMedia["MediaStream"],
    getUserMedia: async (constraints) => {
      asked.push(constraints)
      if (refuse) throw refuse
      return microphone as unknown as MediaStream
    },
    createPlayer: () => {
      const player: FakePlayer = {
        srcObject: null,
        played: 0,
        play: async () => {
          player.played += 1
        },
      }
      players.push(player)
      return player
    },
  }
}

// Tabs that share one origin's locks, each with its own LockManager as in the browser
export function fakeLocks(held: Set<string> = new Set()): LockManager {
  return {
    request: async (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
      if (options.ifAvailable && held.has(name)) return callback(null)
      held.add(name)
      return callback({ name, mode: "exclusive" })
    },
    query: async () => ({ held: [], pending: [] }),
  } as unknown as LockManager
}

export function fakeStorage(
  entries: Record<string, string> = {},
): Storage & { readonly entries: Record<string, string> } {
  return {
    entries,
    get length() {
      return Object.keys(entries).length
    },
    key: (index) => Object.keys(entries)[index] ?? null,
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => {
      entries[key] = value
    },
    removeItem: (key) => {
      delete entries[key]
    },
    clear: () => {
      for (const key of Object.keys(entries)) delete entries[key]
    },
  }
}
