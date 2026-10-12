import { isIntegerIn } from "../support/integer"
import type { Connection, MediaDirection, RtpMap, SessionDescription } from "./types"

const MAX_MEDIA = 16
const DIRECTIONS: ReadonlySet<string> = new Set(["sendrecv", "sendonly", "recvonly", "inactive"])
const TOKEN = "[!#$%&'*+\\-.0-9A-Z^_`a-z{|}~]{1,32}"
const MEDIA = new RegExp(
  `^(${TOKEN}) (\\d{1,5})(?:/\\d{1,5})? (${TOKEN}(?:/${TOKEN})*)((?:[ \\t]+${TOKEN})+)$`,
)
const CONNECTION = /^IN (IP[46]) ([^\s/]+)/
const RTPMAP = /^(\d{1,3}) ([^/\s]+)\/(\d{1,6})(?:\/(\d{1,2}))?$/
const decoder = new TextDecoder("utf-8", { fatal: true })

interface Draft {
  kind: string
  port: number
  protocol: string
  formats: string[]
  connection?: Connection
  direction?: MediaDirection
  rtpmap: Map<number, RtpMap>
  ptime?: number
}

// RFC 8866 §5: lines we do not need are skipped, and a description without v=, o= or m= is unusable
export function parseSdp(data: Uint8Array): SessionDescription | undefined {
  const lines = decode(data)?.split(/\r?\n/) ?? []
  if (lines[0]?.trim() !== "v=0") return undefined
  const session: { origin?: string; connection?: Connection; direction?: MediaDirection } = {}
  const media: Draft[] = []
  for (const line of lines.slice(1)) {
    const type = line.charAt(0)
    const value = line.slice(2).trim()
    if (line.charAt(1) !== "=") continue
    const current = media.at(-1)
    if (type === "m") {
      const draft = parseMedia(value)
      if (!draft || media.length === MAX_MEDIA) return undefined
      media.push(draft)
    } else if (type === "o" && !current) session.origin = value
    else if (type === "c") {
      const [, family, address] = CONNECTION.exec(value) ?? []
      if (family === undefined || address === undefined) continue
      if (current) current.connection = { family, address }
      else session.connection = { family, address }
    } else if (type === "a" && DIRECTIONS.has(value)) {
      if (current) current.direction = value as MediaDirection
      else session.direction = value as MediaDirection
    } else if (type === "a" && current) attribute(value, current)
  }
  if (session.origin === undefined || media.length === 0) return undefined
  return { ...session, origin: session.origin, media }
}

function decode(data: Uint8Array): string | undefined {
  try {
    return decoder.decode(data)
  } catch {
    return undefined
  }
}

function parseMedia(value: string): Draft | undefined {
  const [, kind = "", port = "", protocol = "", formats = ""] = MEDIA.exec(value) ?? []
  const number = Number(port)
  if (kind === "" || !isIntegerIn(number, 0, 65535)) return undefined
  const list = formats.trim().split(/[ \t]+/)
  return { kind, port: number, protocol, formats: list, rtpmap: new Map() }
}

function attribute(value: string, media: Draft): void {
  const colon = value.indexOf(":")
  if (colon === -1) return
  const name = value.slice(0, colon)
  const rest = value.slice(colon + 1).trim()
  if (name === "rtpmap") {
    const match = RTPMAP.exec(rest)
    if (!match) return
    const [, type = "", encoding = "", rate = "", channels] = match
    const map = { name: encoding, rate: Number(rate) }
    media.rtpmap.set(
      Number(type),
      channels === undefined ? map : { ...map, channels: Number(channels) },
    )
  } else if (name === "ptime" && /^\d{1,3}$/.test(rest)) media.ptime = Number(rest)
}
