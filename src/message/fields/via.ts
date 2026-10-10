import { atMost, MAX_VIAS } from "../limits"
import { fail, isToken, show, splitOutside, TOKEN_CHARS } from "../syntax"
import { bareHost, HOST_PATTERN, isHost, isPort, sameHost } from "./host"
import { formatParams, isParams, type Params, parseParams } from "./params"

export interface Via {
  /** Any transport a hop wrote, such as `"UDP"`, `"TLS"` or `"WSS"`. The parser upper-cases it. */
  readonly transport: string
  readonly host: string
  readonly port?: number | undefined
  readonly params: Params
}

const VIA = new RegExp(
  `^SIP[ \\t]*/[ \\t]*2\\.0[ \\t]*/[ \\t]*(${TOKEN_CHARS}+)[ \\t]+(${HOST_PATTERN})(?:[ \\t]*:[ \\t]*(\\d+))?[ \\t]*(;.*)?$`,
  "i",
)

export function parseVias(values: readonly string[]): Via[] {
  const entries = values.flatMap((value) => splitOutside(value, ","))
  return atMost(entries, MAX_VIAS, "Via entries").map(parseVia)
}

export function parseVia(input: string): Via {
  const match = VIA.exec(input.trim())
  if (!match) fail(`Invalid Via ${show(input.trim())}`)
  const [, transport = "", host = "", port, params = ""] = match
  const via = { transport: transport.toUpperCase(), host, params: parseParams(params) }
  if (port === undefined) return via
  const number = Number(port)
  if (!isPort(number)) fail(`Invalid Via port ${show(port)}`)
  return { ...via, port: number }
}

export function isVia(via: Via): boolean {
  const { transport, host, port, params } = via
  return (
    isToken(transport) && isHost(host) && (port === undefined || isPort(port)) && isParams(params)
  )
}

export function withReceived(via: Via, host: string, port: number): Via {
  const params = new Map(via.params)
  const rport = params.has("rport")
  if (rport || !sameHost(via.host, host)) params.set("received", bareHost(host))
  if (rport) params.set("rport", String(port))
  return { ...via, params }
}

export function formatVia(via: Via): string {
  const port = via.port === undefined ? "" : `:${via.port}`
  return `SIP/2.0/${via.transport} ${via.host}${port}${formatParams(via.params)}`
}
