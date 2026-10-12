import type { CallEvent, CoreOutput } from "../core/types"
import { formatHost } from "../message/fields/host"
import type { CallMedia } from "../sdp/types"
import type { TransportAddress } from "../transport/address"
import { decode } from "./codec"
import type { RecordedStep } from "./recorder"

const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu
const WIDTH = 160
const firstLine = new TextDecoder()

/** Draws a recording as a ladder, one line per message or event, like `STRAW_DEBUG=1`. */
export function ladder(recording: string): string {
  return recording
    .split("\n")
    .slice(1)
    .filter((line) => line !== "")
    .flatMap(drawLine)
    .join("\n")
}

export function formatStep(step: RecordedStep): string[] {
  const at = (step.now / 1000).toFixed(3).padStart(9)
  const lines: string[] = []
  if (step.input.type === "receive") {
    lines.push(`${at}  ${place(step.input.from)} → phone  ${summary(step.input.data)}`)
  }
  for (const output of step.outputs ?? []) {
    const line = describe(output)
    if (line) lines.push(`${at}  ${line}`)
  }
  if (step.thrown !== undefined) lines.push(`${at}  ✗ ${step.thrown}`)
  return lines.map(printable)
}

function drawLine(line: string): string[] {
  try {
    const step = decode(line) as RecordedStep | { readonly now: number; readonly oversized: number }
    if (!("oversized" in step)) return formatStep(step)
    const at = (step.now / 1000).toFixed(3).padStart(9)
    return [printable(`${at}  … a step of ${Math.ceil(step.oversized / 1024)} KiB was left out`)]
  } catch {
    return ["          ✗ unreadable step"]
  }
}

function describe(output: CoreOutput): string | undefined {
  if (output.type === "send") return `phone → ${place(output.to)}  ${summary(output.data)}`
  const { event } = output
  if (event.type === "call") return `● call ${call(event)}`
  if (event.type === "invalid") return `● ignored: ${event.error}`
  if (event.type !== "registration") return undefined
  if (event.state === "registered") return `● online for ${event.expires} s`
  if (event.state === "unregistered") return "● unregistered"
  const retry =
    event.retryIn === undefined ? "" : `, retry in ${Math.round(event.retryIn / 1000)} s`
  return `● failed: ${event.failure.reason}${retry}`
}

function call(event: CallEvent): string {
  if (event.state === "incoming") return `incoming from ${event.from.uri}`
  if (event.state === "ringing") return `ringing ${event.status}${describeMedia(event.media)}`
  if (event.state === "live") return `live${describeMedia(event.media)}`
  const { by, reason, status } = event.ended
  const who = by === "local" ? "us" : "them"
  return `ended by ${who}: ${reason}${status === undefined ? "" : ` ${status}`}`
}

function describeMedia(media: CallMedia | undefined): string {
  if (!media) return ""
  const { codec, remote, direction } = media
  const { host, port } = remote
  return ` ${codec} to ${formatHost(host)}:${port}${direction === "sendrecv" ? "" : ` ${direction}`}`
}

function place(address: TransportAddress): string {
  return `${formatHost(address.host)}:${address.port}`
}

function summary(data: Uint8Array): string {
  const text = firstLine.decode(data)
  const end = text.indexOf("\r\n")
  return end === -1 ? text : text.slice(0, end)
}

function printable(text: string): string {
  const safe = text.replace(UNSAFE, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`)
  return safe.length > WIDTH ? `${safe.slice(0, WIDTH - 1)}…` : safe
}
