import { checkCredentials, checkMaxCalls, parseAcceptFrom } from "../core/checks"
import type { Credentials } from "../core/types"
import { formatHost, isSocketHost } from "../message/fields/host"
import { isUri, splitSipUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { defaultPort } from "../transport/address"
import { parseConnectionUrl } from "./url"

/** TLS settings for a `tls://` server. */
export interface TlsOptions {
  /** A PEM certificate authority to trust, for servers with a private certificate. */
  readonly ca?: string | undefined
}

/** Options for `connect()`. */
export interface ConnectUrlOptions {
  /** The SIP password, if it's not in the URL. */
  readonly password?: string | undefined
  /** The auth user, if your provider's differs from your SIP user. */
  readonly authUser?: string | undefined
  /**
   * The one digest realm to answer, for registering and calling. Without it, calls answer the
   * realms your registration answered, and any realm when it answered none, as with
   * `register: false`.
   */
  readonly realm?: string | undefined
  readonly tls?: TlsOptions | undefined
  /** Aborts connecting. Once connected, aborting closes the phone. */
  readonly signal?: AbortSignal | undefined
  /**
   * Records the latest 512 KB of SIP traffic in `phone.trace`.
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
   * Who may call this phone over UDP: your SIP server, `"anyone"` who finds its port, or the server
   * plus a list of IPs and CIDR ranges, like your trunk's signaling addresses. Over TLS only the
   * server can reach it anyway.
   *
   * @default "server"
   */
  readonly acceptFrom?: "server" | "anyone" | readonly string[] | undefined
  /**
   * `false` for a trunk that already knows your address: the phone never registers, and checks
   * instead that the server answers a SIP ping, on connect and every minute after.
   *
   * @default true
   */
  readonly register?: boolean | undefined
  /** The local UDP port, for a trunk that sends calls to a fixed address. Any free one if unset. */
  readonly localPort?: number | undefined
}

/** `connect()` options without a URL. */
export interface ConnectOptions extends ConnectUrlOptions {
  /** Your SIP address, e.g. `"sip:+4930123456@sip.example.com"`. */
  readonly uri: string
  /**
   * `tls://host[:port]` (port 5061 by default) or `udp://host[:port]` (5060). Defaults to the
   * domain of `uri`, over UDP, or TLS for `sips:`.
   */
  readonly server?: string | undefined
}

export interface TlsSettings {
  readonly ca?: string
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
  readonly acceptFrom: "server" | "anyone" | readonly string[]
  readonly register: boolean
  readonly localPort?: number
}

const SERVER = /^(udp|tls):\/\/(\[[^\]]*\]|[^:/[\]]+)(?::(\d{1,5}))?$/i
const TRANSPORT = /;transport=([^;?]*)/i
const SCHEME = /^(?:[a-z][\w+.-]*:\/\/|sips?:|tel:)/i
const BRACKETED = /^\[[^\]]*\]/

export function resolveOptions(
  target: string | ConnectOptions | undefined,
  extra: ConnectUrlOptions = {},
): PhoneSettings {
  const url = typeof target === "string" && target.trim() === "" ? undefined : target
  const options = typeof url === "string" ? fromUrl(url, extra) : url
  if (!options) {
    throw new TypeError(
      "Missing connection URL (is SIP_URL set?): pass tls://user:password@host[:port]",
    )
  }
  const { uri, password, realm, signal, tls, trace = true, maxCalls, register = true } = options
  const { localPort, acceptFrom = "server" } = options
  if (maxCalls !== undefined) checkMaxCalls(maxCalls)
  if (Array.isArray(acceptFrom)) parseAcceptFrom(acceptFrom)
  else if (acceptFrom !== "server" && acceptFrom !== "anyone") {
    throw new TypeError(
      `acceptFrom must be "server", "anyone" or a list of IPs and CIDR ranges, got ${show(acceptFrom)}`,
    )
  }
  if (typeof register !== "boolean") {
    throw new TypeError(`register must be true or false, got ${show(register)}`)
  }
  if (localPort !== undefined && !isIntegerIn(localPort, 1, 65535)) {
    throw new RangeError(`localPort must be an integer from 1 to 65535, got ${show(localPort)}`)
  }
  checkText("uri", uri)
  if (options.server !== undefined) checkText("server", options.server)
  const invalidUri = new TypeError(`Invalid uri ${show(redact(uri))}: use sip:user@domain`)
  const parts = isUri(uri) ? splitSipUri(uri) : undefined
  if (!parts?.user) throw invalidUri
  if (parts.user.includes(":")) throw new TypeError("Pass the password as password, not in the uri")
  if (!parseServer(`udp://${parts.hostport}`)) throw invalidUri
  const server = parseServer(options.server ?? fallback(uri, parts.scheme, parts.hostport))
  const named = options.server ?? ""
  const given = show(redact(named))
  if (!server) throw new TypeError(`Invalid server ${given}: ${hint(named)}`)
  if (parts.scheme === "sips" && server.transport !== "TLS") {
    throw new TypeError(`A sips: uri needs a tls:// server, got ${given}`)
  }
  if (server.transport !== "UDP" && localPort !== undefined) {
    throw new TypeError("localPort only works with a udp:// server")
  }
  if (server.transport !== "UDP" && Array.isArray(acceptFrom)) {
    throw new TypeError("An acceptFrom list only works with a udp:// server")
  }
  if (realm === "") throw new TypeError("realm must not be empty: leave it out instead")
  const username = options.authUser ?? parts.user
  const credentials =
    password === undefined
      ? undefined
      : { username, password, ...(realm === undefined ? {} : { realm }) }
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
    acceptFrom: typeof acceptFrom === "string" ? acceptFrom : [...acceptFrom],
    register,
    ...(localPort === undefined ? {} : { localPort }),
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

// What redact() cuts away, said in words
function hint(server: string): string {
  const port = SERVER.exec(server)?.[3]
  if (port !== undefined && !isIntegerIn(Number(port), 1, 65535)) {
    return "the port must be from 1 to 65535"
  }
  if (/^\w+:\/\/[^/]*\//.test(server)) return "leave out the path"
  return "use udp://host[:port] or tls://host[:port]"
}

function checkText(name: string, value: unknown): asserts value is string {
  if (typeof value === "string") return
  const kind = typeof value === "object" && value !== null ? value.constructor?.name : show(value)
  throw new TypeError(`${name} must be a string, got ${kind ?? "an object"}`)
}

// Errors repeat what was given, but nothing after a user: or host:, where a password may be
function redact(value: string): string {
  const at = value.lastIndexOf("@")
  if (at !== -1) return `…${value.slice(at)}`
  const scheme = SCHEME.exec(value)?.[0].length ?? 0
  const host = BRACKETED.exec(value.slice(scheme))?.[0].length ?? 0
  const colon = value.indexOf(":", scheme + host)
  return colon === -1 ? value : `${value.slice(0, colon)}:…`
}
