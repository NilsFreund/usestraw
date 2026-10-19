import type { RemoteDescription } from "../core/types"
import type { AudioOptions, SdpAudio } from "../phone/platform"
import { SAMPLE_RATE } from "../rtp/g711"
import { onGestures } from "./gestures"
import { closedTap, openTap, type Tap } from "./tap"

/** The browser APIs a call's audio uses, so tests can stand in for them. */
export interface WebMedia {
  readonly RTCPeerConnection: new (configuration: RTCConfiguration) => RTCPeerConnection
  readonly MediaStream: new (tracks: MediaStreamTrack[]) => MediaStream
  readonly AudioContext: (new (options?: AudioContextOptions) => AudioContext) | undefined
  readonly AudioWorkletNode:
    | (new (
        context: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) => AudioWorkletNode)
    | undefined
  // Where the user's clicks and keys land, which let a suspended AudioContext run
  readonly page: EventTarget | undefined
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createPlayer(): Player
}

export interface Player {
  srcObject: MediaProvider | null
  play(): Promise<void>
}

// The answer to an offer can't wait for every candidate: a far end may give up first
const ICE_WAIT = 1000
const VOICE: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

// Calls need WebRTC and a microphone, which browsers give only to secure pages
export function browserMedia(): WebMedia {
  if (globalThis.isSecureContext === false) {
    throw new DOMException(
      "Calls need a secure page: serve it over https or from localhost",
      "SecurityError",
    )
  }
  if (typeof RTCPeerConnection === "undefined" || !globalThis.navigator?.mediaDevices) {
    throw new DOMException("This browser cannot make calls: it has no WebRTC", "NotSupportedError")
  }
  return {
    RTCPeerConnection,
    MediaStream,
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    page: globalThis,
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPlayer: () => new Audio(),
  }
}

// One peer connection per call: the microphone or an agent goes out, the far end to the speakers
export async function openPeerAudio(
  media: WebMedia,
  iceServers: RTCIceServer[],
  silent: () => void,
  options: AudioOptions,
): Promise<SdpAudio> {
  const microphone = options.microphone ? await media.getUserMedia({ audio: VOICE }) : undefined
  let peer: PeerAudio | undefined
  try {
    peer = connectPeer(media, iceServers, silent, microphone)
    // An agent's audio has to run before the call goes out, or the call rings with nobody to talk
    await peer.ready
    return peer.audio
  } catch (error) {
    peer?.audio.close()
    stop(microphone)
    throw error
  }
}

interface PeerAudio {
  readonly audio: SdpAudio
  readonly ready: Promise<void>
}

function connectPeer(
  media: WebMedia,
  iceServers: RTCIceServer[],
  silent: () => void,
  microphone: MediaStream | undefined,
): PeerAudio {
  const peer = new media.RTCPeerConnection({ iceServers })
  const player = media.createPlayer()
  const voice = microphone?.getAudioTracks()[0]
  let sender = microphone && voice ? peer.addTrack(voice, microphone) : undefined
  let far: MediaStream | undefined
  let tap: Tap | undefined
  let ended = false
  let replay: (() => void) | undefined
  peer.addEventListener("track", ({ streams, track }) => {
    if (track.kind !== "audio") return
    far = streams[0] ?? new media.MediaStream([track])
    player.srcObject = far
    play()
    tap?.hear(far)
  })
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") silent()
  })

  // Autoplay may refuse until the user clicks: the far end plays from the next click or key on
  function play(): void {
    player.play().catch(() => {
      if (ended) return
      replay ??= onGestures(media.page, () => {
        replay?.()
        replay = undefined
        play()
      })
    })
  }

  // RFC 8829 §5.10: only a transceiver from addTrack answers an offer, so an agent adds its track
  function send(track: MediaStreamTrack): Promise<void> {
    if (sender) return sender.replaceTrack(track)
    sender = peer.addTrack(track)
    return Promise.resolve()
  }

  // Built on first use, so a call nobody taps keeps its plain microphone path
  function tapped(): Tap {
    if (tap) return tap
    tap = ended ? closedTap() : openTap(media, { microphone, send })
    if (far) tap.hear(far)
    return tap
  }

  async function local(): Promise<string> {
    if (peer.iceGatheringState !== "complete") await gathered(peer)
    const sdp = peer.localDescription?.sdp
    if (!sdp) throw new DOMException("The browser made no session description", "OperationError")
    return sdp
  }

  const audio: SdpAudio = {
    sampleRate: SAMPLE_RATE,
    get played() {
      return tap?.played ?? 0
    },
    get readable() {
      return tapped().readable
    },
    get writable() {
      return tapped().writable
    },
    clear: () => tap?.clear(),
    live: () => tap?.forget(),
    describe: async (remote) => {
      if (remote) {
        await peer.setRemoteDescription(remote)
        audioOnly(peer)
      }
      await peer.setLocalDescription()
      return local()
    },
    apply: (remote) => applied(peer, remote),
    close: () => {
      ended = true
      peer.close()
      stop(microphone)
      player.srcObject = null
      replay?.()
      tap?.close()
    },
  }
  // An agent needs the tap anyway, and Safari starts its audio only while the user's click is fresh
  return { audio, ready: microphone ? Promise.resolve() : tapped().ready }
}

function stop(microphone: MediaStream | undefined): void {
  for (const track of microphone?.getTracks() ?? []) track.stop()
}

// Calls carry audio only, so the answer refuses any video the far end offered
function audioOnly(peer: RTCPeerConnection): void {
  for (const transceiver of peer.getTransceivers()) {
    if (transceiver.receiver.track.kind !== "audio") transceiver.stop()
  }
}

// A rollback undoes whichever side began the offer the call no longer waits on
async function applied(peer: RTCPeerConnection, remote: RemoteDescription): Promise<void> {
  if (remote.type !== "rollback") return peer.setRemoteDescription(remote)
  if (peer.signalingState === "have-local-offer") return peer.setLocalDescription(remote)
  if (peer.signalingState === "have-remote-offer") return peer.setRemoteDescription(remote)
}

function gathered(peer: RTCPeerConnection): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const done = () => {
    if (peer.iceGatheringState === "complete") resolve()
  }
  const timer = setTimeout(resolve, ICE_WAIT)
  peer.addEventListener("icegatheringstatechange", done)
  return promise.finally(() => {
    clearTimeout(timer)
    peer.removeEventListener("icegatheringstatechange", done)
  })
}
