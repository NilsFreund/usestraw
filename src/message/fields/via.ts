import { fail, splitOutside } from "../syntax"
import { formatParams, type Params, parseParams } from "./params"

export interface Via {
  readonly transport: string
  readonly host: string
  readonly port?: number
  readonly params: Params
}

const VIA =
  /^SIP\s*\/\s*2\.0\s*\/\s*([A-Za-z0-9.!%*_+`'~-]+)\s+(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?:\s*:\s*(\d+))?\s*(;.*)?$/i

export function parseVias(values: readonly string[]): Via[] {
  return values.flatMap((value) => splitOutside(value, ",")).map(parseVia)
}

export function parseVia(input: string): Via {
  const match = VIA.exec(input.trim())
  if (!match) fail(`Invalid Via "${input.trim()}"`)
  const [, transport = "", host = "", port, params = ""] = match
  const via = { transport: transport.toUpperCase(), host, params: parseParams(params) }
  if (port === undefined) return via
  const number = Number(port)
  if (number > 65535) fail(`Invalid Via port ${port}`)
  return { ...via, port: number }
}

export function formatVia(via: Via): string {
  const port = via.port === undefined ? "" : `:${via.port}`
  return `SIP/2.0/${via.transport} ${via.host}${port}${formatParams(via.params)}`
}
