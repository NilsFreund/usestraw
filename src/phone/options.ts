import { checkCredentials, checkMaxCalls, parseAcceptFrom } from "../core/checks"
import type { Credentials } from "../core/types"
import { formatHost, isSocketHost } from "../message/fields/host"
import { isUri, splitSipUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { isIp } from "../support/ip"
import { isWebSocket } from "../transport/address"
import { parseConnectionUrl } from "./url"

/** A STUN or TURN server, as `RTCPeerConnection` takes it. TURN needs a username and credential. */
export interface IceServer {
  readonly urls: string | readonly string[]
  readonly username?: string | undefined
  readonly credential?: string | undefined
}

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
   * plus a list of IPs and CIDR ranges, like your trunk's signaling addresses. Over TLS and WebSocket
   * only the server can reach it anyway.
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
  /**
   * STUN and TURN servers for calls in the browser. None by default, which works when the
   * server's media has a public address. Browser only.
   */
  readonly iceServers?: readonly IceServer[] | undefined
}

/** `connect()` options without a URL. */
export interface ConnectOptions extends ConnectUrlOptions {
  /** Your SIP address, e.g. `"sip:+442079460456@sip.example.com"`. */
  readonly uri: string
  /**
   * `tls://host[:port]` (port 5061 by default), `udp://host[:port]` (5060) or
   * `wss://host[:port][/path]` (443). Defaults to the domain of `uri`, over UDP, or TLS for `sips:`.
   * Browsers need `wss://`.
   */
  readonly server?: string | undefined
}

export interface TlsSettings {
  readonly ca?: string
}

export interface Server {
  readonly transport: "UDP" | "TLS" | "WS" | "WSS"
  readonly host: string
  readonly port: number
  readonly path?: string
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
  readonly iceServers?: readonly IceServer[]
}

const SERVER = /^(udp|tls|wss?):\/\/(\[[^\]]*\]|[^:/?#[\]]+)(?::(\d{1,5}))?([/?][^#\s]*)?$/i
const TRANSPORTS = { udp: "UDP", tls: "TLS", ws: "WS", wss: "WSS" } as const
const PORTS = { UDP: 5060, TLS: 5061, WS: 80, WSS: 443 } as const
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
      "Missing connection URL (is SIP_URL set?): pass tls://user:password@host[:port] or wss://…",
    )
  }
  const { uri, password, realm, signal, tls, trace = true, maxCalls, register = true } = options
  const { iceServers } = options
  if (iceServers !== undefined) checkIceServers(iceServers)
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
  if (parts.scheme === "sips" && server.transport !== "TLS" && server.transport !== "WSS") {
    throw new TypeError(`A sips: uri needs a tls:// or wss:// server, got ${given}`)
  }
  if (server.transport === "WS" && !isLoopback(server.host)) {
    throw new TypeError(
      "ws:// sends the password unencrypted, so it only works with localhost: use wss://",
    )
  }
  if (tls?.ca !== undefined && isWebSocket(server.transport)) {
    throw new TypeError(
      "tls.ca only works with a tls:// server; for wss:// the platform's trust store decides (NODE_EXTRA_CA_CERTS in Node)",
    )
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
    label: `${server.transport.toLowerCase()}://${formatHost(server.host)}:${server.port}${withoutQuery(server.path ?? "")}`,
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
    ...(iceServers === undefined ? {} : { iceServers: iceServers.map(copyIceServer) }),
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
  if (transport === "ws" || transport === "wss") {
    throw new TypeError("For WebSocket, pass the server as wss://host[:port][/path]")
  }
  if (transport !== undefined && transport !== "udp" && transport !== "tls") {
    throw new TypeError(
      `Unsupported transport ${show(transport)} in ${show(redact(uri))}: use udp or tls`,
    )
  }
  return `${scheme === "sips" ? "tls" : (transport ?? "udp")}://${hostport}`
}

function parseServer(server: string): Server | undefined {
  const [, scheme = "", host = "", port, path] = SERVER.exec(server) ?? []
  const transport = TRANSPORTS[scheme.toLowerCase() as keyof typeof TRANSPORTS]
  if (transport === undefined || !isSocketHost(host)) return undefined
  const webSocket = isWebSocket(transport)
  if (path !== undefined && !webSocket) return undefined
  const number = port === undefined ? PORTS[transport] : Number(port)
  if (!isIntegerIn(number, 1, 65535)) return undefined
  const bare = host.replace(/^\[(.*)\]$/, "$1")
  if (!webSocket) return { transport, host: bare, port: number }
  const full = path === undefined ? "/" : path.startsWith("?") ? `/${path}` : path
  return { transport, host: bare, port: number, path: full }
}

function isLoopback(host: string): boolean {
  return (
    host.toLowerCase() === "localhost" || host === "::1" || (isIp(host) && host.startsWith("127."))
  )
}

// What redact() cuts away, said in words
function hint(server: string): string {
  const port = SERVER.exec(server)?.[3]
  if (port !== undefined && !isIntegerIn(Number(port), 1, 65535)) {
    return "the port must be from 1 to 65535"
  }
  if (/^(?:udp|tls):\/\/[^/]*\//i.test(server)) return "leave out the path"
  return "use udp://host[:port], tls://host[:port] or wss://host[:port][/path]"
}

const ICE_URL = /^(?:stuns?|turns?):\S+$/
const TURN = /^turns?:/

function checkIceServers(servers: readonly IceServer[]): void {
  const valid =
    Array.isArray(servers) &&
    servers.every((server: unknown) => {
      if (typeof server !== "object" || server === null) return false
      const { urls, username, credential } = server as Record<string, unknown>
      const list = typeof urls === "string" ? [urls] : urls
      if (!Array.isArray(list) || list.length === 0) return false
      if (!list.every((url) => typeof url === "string" && ICE_URL.test(url))) return false
      if (list.some((url) => TURN.test(url))) {
        return typeof username === "string" && typeof credential === "string"
      }
      return (
        (username === undefined || typeof username === "string") &&
        (credential === undefined || typeof credential === "string")
      )
    })
  if (!valid) {
    throw new TypeError(
      "iceServers must list { urls } with stun:, stuns:, turn: or turns: URLs, TURN with a username and credential",
    )
  }
}

function copyIceServer({ urls, username, credential }: IceServer): IceServer {
  return {
    urls: typeof urls === "string" ? urls : [...urls],
    ...(username === undefined ? {} : { username }),
    ...(credential === undefined ? {} : { credential }),
  }
}

function checkText(name: string, value: unknown): asserts value is string {
  if (typeof value === "string") return
  const kind = typeof value === "object" && value !== null ? value.constructor?.name : show(value)
  throw new TypeError(`${name} must be a string, got ${kind ?? "an object"}`)
}

// Errors repeat what was given, but nothing after a user: or host:, where a password may be
// A WebSocket URL's query often carries a token, so it is never repeated
function withoutQuery(value: string): string {
  return value.replace(/\?.*/s, "?…")
}

function redact(given: string): string {
  const value = withoutQuery(given)
  const at = value.lastIndexOf("@")
  if (at !== -1) return `…${value.slice(at)}`
  const scheme = SCHEME.exec(value)?.[0].length ?? 0
  const host = BRACKETED.exec(value.slice(scheme))?.[0].length ?? 0
  const colon = value.indexOf(":", scheme + host)
  return colon === -1 ? value : `${value.slice(0, colon)}:…`
}
