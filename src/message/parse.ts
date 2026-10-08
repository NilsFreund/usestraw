import { parseContact } from "./fields/contact"
import { parseCSeq } from "./fields/cseq"
import { parseNameAddr } from "./fields/name-addr"
import { isRequestUri } from "./fields/uri"
import { parseVias } from "./fields/via"
import { sliceBody, splitHead } from "./framing"
import { canonicalName, isTypedHeader } from "./headers"
import { fail, isToken, ParseError } from "./syntax"
import type { Header, MessageFields, SipMessage } from "./types"

export type ParseResult =
  | { readonly ok: true; readonly message: SipMessage }
  | { readonly ok: false; readonly error: string }

const HEADER = /^([A-Za-z0-9.!%*_+`'~-]+)[ \t]*:(.*)$/
const STATUS_LINE = /^(SIP\/\d+\.\d+) (\d+)(?: (.*))?$/i
const DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

const encoder = new TextEncoder()

export function parseMessage(data: Uint8Array | string): ParseResult {
  try {
    return { ok: true, message: parse(typeof data === "string" ? encoder.encode(data) : data) }
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message }
    throw error
  }
}

function parse(bytes: Uint8Array): SipMessage {
  const [head, bodyStart] = splitHead(bytes)
  const [startLine = "", ...lines] = head.split(/\r?\n/)
  const firstLine = /^SIP\//i.test(startLine)
    ? parseStatusLine(startLine)
    : parseRequestLine(startLine)
  const headers = parseHeaders(lines)
  const body = sliceBody(bytes, bodyStart, single(headers, "Content-Length"))
  const message = { ...firstLine, ...parseFields(headers), body }
  if ("method" in message && message.cseq.method !== message.method) {
    fail(`CSeq method ${message.cseq.method} does not match ${message.method}`)
  }
  return message
}

function parseStatusLine(line: string): { status: number; reason: string } {
  const match = STATUS_LINE.exec(line)
  if (!match) fail(`Invalid status line "${line}"`)
  const [, version = "", code = "", reason = ""] = match
  checkVersion(version)
  if (!/^[1-6]\d\d$/.test(code)) fail(`Invalid status code ${code}`)
  return { status: Number(code), reason }
}

function parseRequestLine(line: string): { method: string; uri: string } {
  const parts = line.split(" ")
  if (parts.length !== 3) fail(`Invalid request line "${line}"`)
  const [method = "", uri = "", version = ""] = parts
  if (!isToken(method)) fail(`Invalid method "${method}"`)
  if (!isRequestUri(uri)) fail(`Invalid Request-URI "${uri}"`)
  checkVersion(version)
  return { method, uri }
}

function checkVersion(version: string): void {
  if (version.toUpperCase() !== "SIP/2.0") fail(`Unsupported SIP version ${version}`)
}

function parseHeaders(lines: string[]): Header[] {
  const headers: { name: string; value: string }[] = []
  for (const line of lines) {
    const previous = headers.at(-1)
    if (/^[ \t]/.test(line)) {
      if (!previous) fail("Header continuation without header")
      previous.value += ` ${line.trim()}`
      continue
    }
    const match = HEADER.exec(line)
    if (!match) fail(`Invalid header line "${line}"`)
    const [, name = "", value = ""] = match
    headers.push({ name: canonicalName(name), value })
  }
  return headers.map(({ name, value }) => ({ name, value: value.trim() }))
}

function parseFields(headers: Header[]): Omit<MessageFields, "body"> {
  const via = parseVias(values(headers, "Via"))
  if (via.length === 0) fail("Missing Via header")
  const from = parseNameAddr(required(headers, "From"))
  const to = parseNameAddr(required(headers, "To"))
  const callId = required(headers, "Call-ID")
  if (!/^\S+$/.test(callId)) fail(`Invalid Call-ID "${callId}"`)
  const cseq = parseCSeq(required(headers, "CSeq"))
  const maxForwards = single(headers, "Max-Forwards")
  const contact = parseContact(values(headers, "Contact"))
  for (const date of values(headers, "Date")) {
    if (!DATE.test(date)) fail(`Invalid Date "${date}"`)
  }
  return {
    via,
    from,
    to,
    callId,
    cseq,
    contact,
    headers: headers.filter((header) => !isTypedHeader(header.name)),
    ...(maxForwards === undefined ? {} : { maxForwards: parseMaxForwards(maxForwards) }),
  }
}

function parseMaxForwards(value: string): number {
  const hops = Number(value)
  if (!/^\d+$/.test(value) || hops > 255) fail(`Invalid Max-Forwards "${value}"`)
  return hops
}

function values(headers: Header[], name: string): string[] {
  return headers.filter((header) => header.name === name).map((header) => header.value)
}

function single(headers: Header[], name: string): string | undefined {
  const found = values(headers, name)
  if (found.length > 1) fail(`Multiple ${name} headers`)
  return found[0]
}

function required(headers: Header[], name: string): string {
  return single(headers, name) ?? fail(`Missing ${name} header`)
}
