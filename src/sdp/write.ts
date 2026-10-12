import { bareHost } from "../message/fields/host"
import type { MediaDescription } from "./types"

export interface Origin {
  readonly id: string
  readonly version: number
  readonly host: string
}

const encoder = new TextEncoder()

export function writeMedia(host: string, media: readonly MediaDescription[]): string {
  const address = bareHost(host)
  const lines = ["s=-", `c=IN ${family(address)} ${address}`, "t=0 0"]
  for (const { kind, port, protocol, formats, rtpmap, ptime, direction } of media) {
    lines.push(`m=${kind} ${port} ${protocol} ${formats.join(" ")}`)
    for (const [type, { name, rate, channels }] of rtpmap) {
      lines.push(`a=rtpmap:${type} ${name}/${rate}${channels === undefined ? "" : `/${channels}`}`)
    }
    if (ptime !== undefined) lines.push(`a=ptime:${ptime}`)
    if (direction !== undefined) lines.push(`a=${direction}`)
  }
  return lines.join("\r\n")
}

// RFC 8866 §5.2: we have no user name, so the origin starts with "-"
export function writeSdp(origin: Origin, body: string): Uint8Array {
  const address = bareHost(origin.host)
  const head = `v=0\r\no=- ${origin.id} ${origin.version} IN ${family(address)} ${address}`
  return encoder.encode(`${head}\r\n${body}\r\n`)
}

function family(address: string): string {
  return address.includes(":") ? "IP6" : "IP4"
}
