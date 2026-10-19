import type { Player, WebMedia } from "../../src/web/peer"
import { createResampler } from "../../src/web/resample"
import { defineTap, type Processor } from "../../src/web/worklet"

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

export class FakeSender {
  track: FakeTrack | null
  readonly replaced: FakeTrack[] = []
  constructor(track: FakeTrack | null) {
    this.track = track
  }
  refuse = false
  async replaceTrack(track: FakeTrack): Promise<void> {
    if (this.refuse) throw new DOMException("closed", "InvalidStateError")
    this.track = track
    this.replaced.push(track)
  }
}

export class FakePeer extends EventTarget {
  static last: FakePeer | undefined
  readonly configuration: RTCConfiguration
  readonly added: [FakeTrack, FakeStream | undefined][] = []
  readonly senders: FakeSender[] = []
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

  // No addTransceiver: an offer from the far end would leave its sender out (RFC 8829 §5.10)
  addTrack(track: FakeTrack, stream?: FakeStream): FakeSender {
    this.added.push([track, stream])
    const sender = new FakeSender(track)
    this.senders.push(sender)
    return sender
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

export class FakeNode {
  readonly connected: unknown[] = []
  disconnected = false
  readonly stream: FakeStream | undefined
  constructor(stream?: FakeStream) {
    this.stream = stream
  }
  connect(node: unknown): void {
    this.connected.push(node)
  }
  disconnect(): void {
    this.disconnected = true
  }
}

// The real tap processor runs behind the node's port, driven by tests through render()
export class FakeWorkletNode extends FakeNode {
  static last: FakeWorkletNode | undefined
  readonly port: MessagePort
  readonly processor: InstanceType<Processor>
  readonly name: string
  readonly options: AudioWorkletNodeOptions | undefined
  private readonly other: MessagePort

  constructor(context: FakeAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    super()
    const channel = new MessageChannel()
    this.port = channel.port1
    this.other = channel.port2
    this.name = name
    this.options = options
    const other = this.other
    class Base {
      readonly port = other
    }
    let Tap: Processor | undefined
    defineTap((processor) => (Tap = processor), Base, context.sampleRate, createResampler)
    this.processor = new (Tap as Processor)()
    context.nodes.push(this)
    FakeWorkletNode.last = this
  }

  // One render quantum: what the far end said in, what the far end hears out
  render(heard: Float32Array[] = []): Float32Array {
    const output = new Float32Array(128)
    this.processor.process([heard], [[output]])
    return output
  }

  shut(): void {
    this.port.close()
    this.other.close()
  }
}

// Starts as the browser lets it: running, or suspended until resume() is allowed through
export class FakeAudioContext extends EventTarget {
  static last: FakeAudioContext | undefined
  static failLoad: Error | undefined
  static blocked = false
  static failCreate: Error | undefined
  readonly sampleRate = 48_000
  readonly options: AudioContextOptions | undefined
  readonly nodes: FakeWorkletNode[] = []
  readonly sources: FakeNode[] = []
  readonly destination: FakeNode & { stream: FakeStream } = Object.assign(new FakeNode(), {
    stream: new FakeStream(),
  })
  readonly loaded: string[] = []
  state: string = FakeAudioContext.blocked ? "suspended" : "running"
  resumes = 0
  refuseResume = false
  readonly audioWorklet: { addModule(url: string): Promise<void> } = {
    addModule: async (url) => {
      this.loaded.push(url)
      if (FakeAudioContext.failLoad) throw FakeAudioContext.failLoad
    },
  }

  constructor(options?: AudioContextOptions) {
    super()
    if (FakeAudioContext.failCreate) throw FakeAudioContext.failCreate
    this.options = options
    FakeAudioContext.last = this
  }

  resume(): Promise<void> {
    this.resumes += 1
    if (this.refuseResume) return Promise.reject(new DOMException("closing", "InvalidStateError"))
    if (FakeAudioContext.blocked) return new Promise(() => undefined)
    this.interrupt("running")
    return Promise.resolve()
  }

  // The browser changing its state, as Safari's "interrupted" when another app takes the audio
  interrupt(state = "interrupted"): void {
    this.state = state
    this.dispatchEvent(new Event("statechange"))
  }

  static forget(): void {
    FakeAudioContext.last = undefined
  }

  createMediaStreamDestination(): FakeNode & { stream: FakeStream } {
    return this.destination
  }

  createMediaStreamSource(stream: FakeStream): FakeNode {
    const source = new FakeNode(stream)
    this.sources.push(source)
    return source
  }

  async close(): Promise<void> {
    if (this.state === "closed") throw new DOMException("closed already", "InvalidStateError")
    this.state = "closed"
    for (const node of this.nodes) node.shut()
  }
}

export interface FakeMedia extends WebMedia {
  readonly page: EventTarget
  readonly players: FakePlayer[]
  readonly asked: MediaStreamConstraints[]
  readonly microphone: FakeStream
}

export interface FakePlayer extends Player {
  played: number
  // Autoplay refuses until the user clicks
  blocked: boolean
}

export function fakeMedia({
  refuse,
  webAudio = true,
}: {
  refuse?: DOMException
  webAudio?: boolean
} = {}): FakeMedia {
  const players: FakePlayer[] = []
  const asked: MediaStreamConstraints[] = []
  const microphone = new FakeStream()
  return {
    page: new EventTarget(),
    players,
    asked,
    microphone,
    RTCPeerConnection: FakePeer as unknown as WebMedia["RTCPeerConnection"],
    MediaStream: FakeStream as unknown as WebMedia["MediaStream"],
    AudioContext: webAudio ? (FakeAudioContext as unknown as WebMedia["AudioContext"]) : undefined,
    AudioWorkletNode: webAudio
      ? (FakeWorkletNode as unknown as WebMedia["AudioWorkletNode"])
      : undefined,
    getUserMedia: async (constraints) => {
      asked.push(constraints)
      if (refuse) throw refuse
      return microphone as unknown as MediaStream
    },
    createPlayer: () => {
      const player: FakePlayer = {
        srcObject: null,
        played: 0,
        blocked: false,
        play: async () => {
          if (player.blocked) throw new DOMException("no click yet", "NotAllowedError")
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
