import { checkCredentials } from "../core/checks"
import type { Credentials } from "../core/types"
import { formatHost, isSocketHost } from "../message/fields/host"
import { isUri, splitSipUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { defaultPort } from "../transport/address"
import type { TlsSettings } from "./links"
import { parseConnectionUrl } from "./url"

export interface TlsOptions {
  readonly ca?: string | undefined
}

export interface ConnectUrlOptions {
  readonly password?: string | undefined
  readonly authUser?: string | undefined
  readonly tls?: TlsOptions | undefined
  readonly signal?: AbortSignal | undefined
}

export interface ConnectOptions extends ConnectUrlOptions {
  readonly uri: string
  readonly server?: string | undefined
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
  readonly tls?: TlsSettings
}

const SERVER = /^(udp|tls):\/\/(\[[^\]]*\]|[^:/[\]]+)(?::(\d{1,5}))?$/i
const TRANSPORT = /;transport=([^;?]*)/i

export function resolveOptions(
  target: string | ConnectOptions | undefined,
  extra: ConnectUrlOptions = {},
): PhoneSettings {
  const options = typeof target === "string" ? fromUrl(target, extra) : target
  if (!options) {
    throw new TypeError("Missing connection URL: pass tls://user:password@host[:port]")
  }
  const { uri, password, signal, tls } = options
  const invalidUri = new TypeError(`Invalid uri ${show(redact(uri))}: use sip:user@domain`)
  const parts = isUri(uri) ? splitSipUri(uri) : undefined
  if (!parts?.user) throw invalidUri
  if (parts.user.includes(":")) throw new TypeError("Pass the password as password, not in the uri")
  if (!parseServer(`udp://${parts.hostport}`)) throw invalidUri
  const server = parseServer(options.server ?? fallback(uri, parts.scheme, parts.hostport))
  const given = show(redact(options.server ?? ""))
  if (!server) {
    throw new TypeError(`Invalid server ${given}: use udp://host[:port] or tls://host[:port]`)
  }
  if (parts.scheme === "sips" && server.transport !== "TLS") {
    throw new TypeError(`A sips: uri needs a tls:// server, got ${given}`)
  }
  const username = options.authUser ?? parts.user
  const credentials = password === undefined ? undefined : { username, password }
  if (credentials) checkCredentials(credentials)
  return {
    aor: uri,
    registrar: `${parts.scheme}:${parts.hostport}`,
    username,
    server,
    label: `${server.transport.toLowerCase()}://${formatHost(server.host)}:${server.port}`,
    closeTimeout: 5000,
    connectTimeout: 10_000,
    ...(credentials ? { credentials } : {}),
    ...(signal ? { signal } : {}),
    ...(tls?.ca === undefined ? {} : { tls: { ca: tls.ca } }),
  }
}

function fromUrl(url: string, extra: ConnectUrlOptions): ConnectOptions {
  const { uri, server, user, password: inUrl } = parseConnectionUrl(url)
  if (inUrl !== undefined && extra.password !== undefined) {
    throw new TypeError("Pass the password in the URL or as password, not both")
  }
  return {
    ...extra,
    uri,
    server,
    authUser: extra.authUser ?? user,
    ...(inUrl === undefined ? {} : { password: inUrl }),
  }
}

function fallback(uri: string, scheme: string, hostport: string): string {
  const transport = TRANSPORT.exec(uri.slice(uri.indexOf("@")))?.[1]?.toLowerCase()
  if (transport !== undefined && transport !== "udp" && transport !== "tls") {
    throw new TypeError(
      `Unsupported transport ${show(transport)} in ${show(redact(uri))}: use udp or tls`,
    )
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

function redact(value: string): string {
  const at = value.lastIndexOf("@")
  return at === -1 ? value : `…${value.slice(at)}`
}
