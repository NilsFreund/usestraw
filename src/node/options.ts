import { checkCredentials, checkMaxCalls } from "../core/checks"
import type { Credentials } from "../core/types"
import { formatHost, isSocketHost } from "../message/fields/host"
import { isUri, splitSipUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { defaultPort } from "../transport/address"
import type { TlsSettings } from "./links"
import { parseConnectionUrl } from "./url"

/** TLS settings for a `tls://` server. */
export interface TlsOptions {
  /** A PEM certificate authority to trust, for servers with a private certificate. */
  readonly ca?: string | undefined
}

/** Options for {@link connect}. */
export interface ConnectUrlOptions {
  /** The SIP password, if it's not in the URL. */
  readonly password?: string | undefined
  /** The auth user, if your provider's differs from your SIP user. */
  readonly authUser?: string | undefined
  readonly tls?: TlsOptions | undefined
  /** Aborts connecting. Once connected, aborting closes the phone. */
  readonly signal?: AbortSignal | undefined
  /**
   * Records the latest 512 KB of SIP traffic in {@link Phone.trace}.
   *
   * @default true
   */
  readonly trace?: boolean | undefined
  /**
   * Incoming calls get busy while this many calls run, in either direction. `0` refuses them all.
   *
   * @default 100
   */
  readonly maxCalls?: number | undefined
  /**
   * Who may call this phone over UDP: only your SIP server, or `"anyone"` who finds its port, for
   * direct IP calls. Over TLS only the server can reach it anyway.
   *
   * @default "server"
   */
  readonly acceptFrom?: "server" | "anyone" | undefined
}

/** {@link connect} options without a URL. */
export interface ConnectOptions extends ConnectUrlOptions {
  /** Your SIP address, e.g. `"sip:+4930123456@sip.example.com"`. */
  readonly uri: string
  /**
   * `tls://host[:port]` (port 5061 by default) or `udp://host[:port]` (5060). Defaults to the
   * domain of `uri`, over UDP, or TLS for `sips:`.
   */
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
  readonly trace: boolean
  readonly maxCalls?: number
  readonly acceptFrom: "server" | "anyone"
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
  const { uri, password, signal, tls, trace = true, maxCalls, acceptFrom = "server" } = options
  if (maxCalls !== undefined) checkMaxCalls(maxCalls)
  if (acceptFrom !== "server" && acceptFrom !== "anyone") {
    throw new TypeError(`acceptFrom must be "server" or "anyone", got ${show(acceptFrom)}`)
  }
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
    trace,
    acceptFrom,
    ...(credentials ? { credentials } : {}),
    ...(signal ? { signal } : {}),
    ...(maxCalls === undefined ? {} : { maxCalls }),
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
