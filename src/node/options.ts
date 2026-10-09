import { checkCredentials, checkExpires } from "../core/checks"
import type { Credentials } from "../core/types"
import { formatHost, isSocketHost } from "../message/fields/host"
import { isUri, splitSipUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { defaultPort } from "../transport/address"

export interface TlsOptions {
  readonly ca?: string
  readonly rejectUnauthorized?: boolean
}

export interface RegisterOptions {
  readonly uri: string
  readonly password?: string
  readonly username?: string
  readonly server?: string
  readonly expires?: number
  readonly closeTimeout?: number
  readonly tls?: TlsOptions
  readonly signal?: AbortSignal
}

export interface Server {
  readonly transport: "UDP" | "TLS"
  readonly host: string
  readonly port: number
}

export interface PhoneSettings {
  readonly aor: string
  readonly registrar: string
  readonly username: string
  readonly server: Server
  readonly label: string
  readonly closeTimeout: number
  readonly connectTimeout: number
  readonly credentials?: Credentials
  readonly expires?: number
  readonly signal?: AbortSignal
  readonly tls?: TlsOptions
}

const SERVER = /^(udp|tls):\/\/(\[[^\]]*\]|[^:/[\]]+)(?::(\d{1,5}))?$/i
const TRANSPORT = /;transport=([^;?]*)/i
const MAX_TIMEOUT = 2 ** 31 - 1

export function resolveOptions(options: RegisterOptions): PhoneSettings {
  const { uri, password, expires, closeTimeout = 5000, signal, tls } = options
  const parts = isUri(uri) ? splitSipUri(uri) : undefined
  if (!parts?.user) throw new TypeError(`Invalid uri ${show(uri)}: use sip:user@domain`)
  if (parts.user.includes(":")) throw new TypeError("Pass the password as password, not in the uri")
  const server = parseServer(options.server ?? fallback(uri, parts.scheme, parts.hostport))
  if (!server) {
    throw options.server === undefined
      ? new TypeError(`Invalid uri ${show(uri)}: use sip:user@domain`)
      : new TypeError(
          `Invalid server ${show(options.server)}: use udp://host[:port] or tls://host[:port]`,
        )
  }
  if (parts.scheme === "sips" && server.transport !== "TLS") {
    throw new TypeError(`A sips: uri needs a tls:// server, got ${show(options.server)}`)
  }
  const username = options.username ?? parts.user
  const credentials = password === undefined ? undefined : { username, password }
  if (credentials) checkCredentials(credentials)
  if (expires !== undefined) checkExpires(expires)
  if (!isIntegerIn(closeTimeout, 0, MAX_TIMEOUT)) {
    throw new RangeError(`Invalid closeTimeout ${show(closeTimeout)}`)
  }
  return {
    aor: uri,
    registrar: `${parts.scheme}:${parts.hostport}`,
    username,
    server,
    label: `${server.transport.toLowerCase()}://${formatHost(server.host)}:${server.port}`,
    closeTimeout,
    connectTimeout: 10_000,
    ...(credentials ? { credentials } : {}),
    ...(expires === undefined ? {} : { expires }),
    ...(signal ? { signal } : {}),
    ...(tls ? { tls } : {}),
  }
}

function fallback(uri: string, scheme: string, hostport: string): string {
  const transport = TRANSPORT.exec(uri.slice(uri.indexOf("@")))?.[1]?.toLowerCase()
  if (transport !== undefined && transport !== "udp" && transport !== "tls") {
    throw new TypeError(`Unsupported transport ${show(transport)} in ${show(uri)}: use udp or tls`)
  }
  return `${scheme === "sips" ? "tls" : (transport ?? "udp")}://${hostport}`
}

function parseServer(server: string): Server | undefined {
  const [, scheme, host = "", port] = SERVER.exec(server) ?? []
  if (scheme === undefined || !isSocketHost(host)) return undefined
  const transport = scheme.toUpperCase() === "TLS" ? "TLS" : "UDP"
  const number = port === undefined ? defaultPort(transport) : Number(port)
  if (!isIntegerIn(number, 1, 65535)) return undefined
  return { transport, host: host.replace(/^\[(.*)\]$/, "$1"), port: number }
}
