import { pcmStreams } from "../phone/streams"
import { SAMPLES_PER_MS } from "../rtp/g711"
import { onGestures } from "./gestures"
import type { WebMedia } from "./peer"
import { TAP, type TapOrder, type TapReport, tapSource } from "./worklet"

export interface Tap {
  readonly readable: ReadableStream<Int16Array<ArrayBuffer>>
  readonly writable: WritableStream<Int16Array>
  readonly played: number
  // Settles once the worklet runs, or rejects with why it can't
  readonly ready: Promise<void>
  hear(stream: MediaStream): void
  forget(): void
  clear(): void
  close(): void
}

// Where the tap's audio goes out: the call's sender, mixed with the microphone if there is one
export interface TapOutput {
  readonly microphone: MediaStream | undefined
  send(track: MediaStreamTrack): Promise<void>
}

// call.audio in the browser: an AudioWorklet turns the call's audio into 8 kHz PCM and back
export function openTap(media: WebMedia, output: TapOutput): Tap {
  let written = 0
  let taken = 0
  let played = 0
  let speaking = false
  let closed = false
  let node: AudioWorkletNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  const pending: TapOrder[] = []
  const streams = pcmStreams({
    get queued() {
      return written - taken
    },
    write: (pcm) => {
      written += pcm.length
      order({ type: "pcm", pcm })
      speak()
    },
    clear: () => order({ type: "clear" }),
  })
  const started = start(media)
  const audio = "context" in started ? started : undefined
  const sleep = audio && wake(audio.context, media.page)

  function order(next: TapOrder): void {
    if (!node) pending.push(next)
    else if (next.type === "pcm") node.port.postMessage(next, [next.pcm.buffer])
    else node.port.postMessage(next)
  }

  // The microphone keeps its plain path until the app speaks too, and the context runs, or the far
  // end would hear nothing; an agent speaks from the start
  function speak(): void {
    if (speaking || !audio) return
    speaking = true
    const { context, destination } = audio
    const running = () => {
      if (context.state !== "running") return
      context.removeEventListener("statechange", running)
      if (!closed) send(destination)
    }
    if (output.microphone) context.createMediaStreamSource(output.microphone).connect(destination)
    if (output.microphone && context.state !== "running")
      context.addEventListener("statechange", running)
    else send(destination)
  }

  function send(destination: MediaStreamAudioDestinationNode): void {
    for (const track of destination.stream.getAudioTracks()) {
      output.send(track).catch(() => undefined)
    }
  }

  function report({ data }: MessageEvent<TapReport>): void {
    if (data.type === "frame") {
      streams.hear(data.pcm)
      return
    }
    taken = data.taken
    played = data.played
    streams.sent()
  }

  async function load({ context, destination, Worklet }: Audio): Promise<void> {
    const url = URL.createObjectURL(new Blob([tapSource()], { type: "text/javascript" }))
    try {
      await context.audioWorklet.addModule(url)
    } catch (error) {
      throw blocked(error)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (closed) return
    node = new Worklet(context, TAP, { outputChannelCount: [1] })
    node.port.onmessage = report
    node.connect(destination)
    source?.connect(node)
    for (const next of pending.splice(0)) order(next)
  }

  function close(error?: unknown): void {
    if (closed) return
    closed = true
    streams.close(error)
    node?.port.close()
    sleep?.()
    audio?.context.close().catch(() => undefined)
  }

  const loading = "failure" in started ? Promise.reject(started.failure) : load(started)
  const ready = loading.catch((error: unknown) => {
    close(error)
    throw error
  })
  ready.catch(() => undefined)
  if (!output.microphone) speak()

  return {
    readable: streams.readable,
    writable: streams.writable,
    get played() {
      return played / SAMPLES_PER_MS
    },
    ready,
    hear: (stream) => {
      if (!audio || closed) return
      source?.disconnect()
      source = audio.context.createMediaStreamSource(stream)
      if (node) source.connect(node)
    },
    forget: () => streams.forget(),
    clear: () => order({ type: "clear" }),
    close: () => close(),
  }
}

// For a call that already ended: its streams are over, and no Web Audio gets built for them
export function closedTap(): Tap {
  const streams = pcmStreams({ queued: 0, write: nothing, clear: nothing })
  streams.close()
  const { readable, writable } = streams
  return {
    readable,
    writable,
    played: 0,
    ready: Promise.resolve(),
    hear: nothing,
    forget: nothing,
    clear: nothing,
    close: nothing,
  }
}

const nothing = (): void => undefined

interface Audio {
  readonly context: AudioContext
  readonly destination: MediaStreamAudioDestinationNode
  readonly Worklet: NonNullable<WebMedia["AudioWorkletNode"]>
}

interface Failure {
  readonly failure: unknown
}

// Never throws, so a peer connection around it can't leak
function start({ AudioContext, AudioWorkletNode }: WebMedia): Audio | Failure {
  if (!AudioContext || !AudioWorkletNode) return { failure: unsupported() }
  try {
    const context = new AudioContext({ latencyHint: "interactive" })
    return {
      context,
      destination: context.createMediaStreamDestination(),
      Worklet: AudioWorkletNode,
    }
  } catch (failure) {
    return { failure }
  }
}

// A context starts suspended without a recent click and pauses for other apps; resume() stays
// pending while the browser blocks it, so every click and state change tries again
function wake(context: AudioContext, page: EventTarget | undefined): () => void {
  const resume = () => {
    if (context.state !== "running" && context.state !== "closed") {
      context.resume().catch(() => undefined)
    }
  }
  resume()
  context.addEventListener("statechange", resume)
  return onGestures(page, resume)
}

function unsupported(): DOMException {
  return new DOMException(
    "This browser has no AudioWorklet, which call.audio needs: use a current browser",
    "NotSupportedError",
  )
}

// CSP: a worklet module is a script, and 'self' never covers blob: URLs
function blocked(error: unknown): DOMException {
  return new DOMException(
    `The browser would not load the audio worklet that call.audio needs (${String(error)}): if the page has a Content-Security-Policy, allow blob: in script-src (or script-src-elem)`,
    "SecurityError",
  )
}
