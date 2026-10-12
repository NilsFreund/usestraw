import { isCallId } from "./fields/call-id"
import { parseContact } from "./fields/contact"
import { parseCSeq } from "./fields/cseq"
import { parseMaxForwards } from "./fields/max-forwards"
import { parseNameAddr } from "./fields/name-addr"
import { isRequestUri } from "./fields/uri"
import { parseVias } from "./fields/via"
import { sliceBody, splitHead } from "./framing"
import { canonicalName, isTypedHeader } from "./headers"
import { atMost, MAX_HEADER_LINES, MAX_MESSAGE_SIZE } from "./limits"
import { isStatusCode } from "./status"
import { fail, hasControl, hasRawControl, isToken, ParseError, show, TOKEN_CHARS } from "./syntax"
import type { MessageFields, SipHeader, SipMessage } from "./types"

/** A parsed message, or why the input is not one. */
export type ParseResult =
  | { readonly ok: true; readonly message: SipMessage }
  | { readonly ok: false; readonly error: string }

const HEADER = new RegExp(`^(${TOKEN_CHARS}+)[ \\t]*:(.*)$`, "s")
const STATUS_LINE = /^(SIP\/\d+\.\d+) (\d+)(?: (.*))?$/is
const DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

const encoder = new TextEncoder()

/**
 * Parses one SIP message (RFC 3261 §7). Never throws: bad input gives `ok: false` with an error.
 * Size and header limits keep hostile input cheap.
 */
export function parseMessage(data: Uint8Array | string): ParseResult {
  try {
    return { ok: true, message: parse(typeof data === "string" ? encoder.encode(data) : data) }
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message }
    throw error
  }
}

function parse(bytes: Uint8Array): SipMessage {
  if (bytes.length > MAX_MESSAGE_SIZE) fail(`Message exceeds ${MAX_MESSAGE_SIZE} bytes`)
  const [head, bodyStart] = splitHead(bytes)
  const [startLine = "", ...lines] = head.split(/\r?\n/)
  const firstLine = /^SIP\//i.test(startLine)
    ? parseStatusLine(startLine)
    : parseRequestLine(startLine)
  const headers = parseHeaders(atMost(lines, MAX_HEADER_LINES, "header lines"))
  const body = sliceBody(bytes, bodyStart, single(headers, "Content-Length"))
  const message = { ...firstLine, ...parseFields(headers), body }
  if ("method" in message && message.cseq.method !== message.method) {
    fail(`CSeq method ${message.cseq.method} does not match ${message.method}`)
  }
  return message
}

function parseStatusLine(line: string): { status: number; reason: string } {
  const match = STATUS_LINE.exec(line)
  if (!match) fail(`Invalid status line ${show(line)}`)
  const [, version = "", code = "", reason = ""] = match
  checkVersion(version)
  if (!/^\d{3}$/.test(code) || !isStatusCode(Number(code))) {
    fail(`Invalid status code ${show(code)}`)
  }
  if (hasControl(reason)) fail("Invalid character in reason phrase")
  return { status: Number(code), reason }
}

function parseRequestLine(line: string): { method: string; uri: string } {
  const parts = line.split(" ")
  if (parts.length !== 3) fail(`Invalid request line ${show(line)}`)
  const [method = "", uri = "", version = ""] = parts
  if (!isToken(method)) fail(`Invalid method ${show(method)}`)
  if (!isRequestUri(uri)) fail(`Invalid Request-URI ${show(uri)}`)
  checkVersion(version)
  return { method, uri }
}

function checkVersion(version: string): void {
  if (version.toUpperCase() !== "SIP/2.0") fail(`Unsupported SIP version ${show(version)}`)
}

export function splitHeaderLine(line: string): { name: string; value: string } | undefined {
  const [, name, value = ""] = HEADER.exec(line) ?? []
  return name === undefined ? undefined : { name: canonicalName(name), value }
}

function parseHeaders(lines: string[]): SipHeader[] {
  const headers: { name: string; value: string }[] = []
  for (const line of lines) {
    const previous = headers.at(-1)
    if (/^[ \t]/.test(line)) {
      if (!previous) fail("Header continuation without header")
      previous.value += ` ${line.trim()}`
      continue
    }
    headers.push(splitHeaderLine(line) ?? fail(`Invalid header line ${show(line)}`))
  }
  for (const { name, value } of headers) {
    if (hasRawControl(value)) fail(`Invalid character in ${name} header`)
  }
  return headers.map(({ name, value }) => ({ name, value: value.trim() }))
}

function parseFields(headers: SipHeader[]): Omit<MessageFields, "body"> {
  const via = parseVias(values(headers, "Via"))
  if (via.length === 0) fail("Missing Via header")
  const from = parseNameAddr(required(headers, "From"))
  const to = parseNameAddr(required(headers, "To"))
  const callId = required(headers, "Call-ID")
  if (!isCallId(callId)) fail(`Invalid Call-ID ${show(callId)}`)
  const cseq = parseCSeq(required(headers, "CSeq"))
  const maxForwards = single(headers, "Max-Forwards")
  const contact = parseContact(values(headers, "Contact"))
  for (const date of values(headers, "Date")) {
    if (!DATE.test(date)) fail(`Invalid Date ${show(date)}`)
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

function values(headers: SipHeader[], name: string): string[] {
  return headers.filter((header) => header.name === name).map((header) => header.value)
}

function single(headers: SipHeader[], name: string): string | undefined {
  const found = values(headers, name)
  if (found.length > 1) fail(`Multiple ${name} headers`)
  return found[0]
}

function required(headers: SipHeader[], name: string): string {
  return single(headers, name) ?? fail(`Missing ${name} header`)
}
