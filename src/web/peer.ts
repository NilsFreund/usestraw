import type { RemoteDescription } from "../core/types"
import type { SdpAudio } from "../phone/platform"

/** The browser APIs a call's audio uses, so tests can stand in for them. */
export interface WebMedia {
  readonly RTCPeerConnection: new (configuration: RTCConfiguration) => RTCPeerConnection
  readonly MediaStream: new (tracks: MediaStreamTrack[]) => MediaStream
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
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPlayer: () => new Audio(),
  }
}

// One peer connection per call: the microphone goes out, the far end comes out of the speakers
export async function openPeerAudio(
  media: WebMedia,
  iceServers: RTCIceServer[],
  silent: () => void,
): Promise<SdpAudio> {
  const microphone = await media.getUserMedia({ audio: VOICE })
  try {
    return connectPeer(media, iceServers, silent, microphone)
  } catch (error) {
    for (const track of microphone.getTracks()) track.stop()
    throw error
  }
}

function connectPeer(
  media: WebMedia,
  iceServers: RTCIceServer[],
  silent: () => void,
  microphone: MediaStream,
): SdpAudio {
  const peer = new media.RTCPeerConnection({ iceServers })
  for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone)
  const player = media.createPlayer()
  const heard = placeholder()
  peer.addEventListener("track", ({ streams, track }) => {
    if (track.kind !== "audio") return
    player.srcObject = streams[0] ?? new media.MediaStream([track])
    player.play().catch(() => undefined)
  })
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") silent()
  })

  async function local(): Promise<string> {
    if (peer.iceGatheringState !== "complete") await gathered(peer)
    const sdp = peer.localDescription?.sdp
    if (!sdp) throw new DOMException("The browser made no session description", "OperationError")
    return sdp
  }

  return {
    sampleRate: 8000,
    played: 0,
    readable: heard.readable,
    writable: heard.writable,
    clear: () => undefined,
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
      peer.close()
      for (const track of microphone.getTracks()) track.stop()
      player.srcObject = null
      heard.close()
    },
  }
}

// Calls carry audio only, so the answer refuses any video the far end offered
function audioOnly(peer: RTCPeerConnection): void {
  for (const transceiver of peer.getTransceivers()) {
    if (transceiver.receiver.track.kind !== "audio") transceiver.stop()
  }
}

// call.audio as PCM comes with the AudioWorklet tap; until then its streams just end with the call
function placeholder() {
  let reading: ReadableStreamDefaultController<Int16Array<ArrayBuffer>> | undefined
  let writing: WritableStreamDefaultController | undefined
  const readable = new ReadableStream<Int16Array<ArrayBuffer>>({
    start: (controller) => {
      reading = controller
    },
    cancel: () => {
      reading = undefined
    },
  })
  const writable = new WritableStream<Int16Array>({
    start: (controller) => {
      writing = controller
    },
  })
  return {
    readable,
    writable,
    close: () => {
      reading?.close()
      reading = undefined
      writing?.error(new DOMException("The call ended", "AbortError"))
    },
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
