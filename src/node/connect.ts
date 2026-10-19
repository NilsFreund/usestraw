import {
  type ConnectOptions,
  type ConnectUrlOptions,
  type PhoneSettings,
  resolveOptions,
} from "../phone/options"
import { connectPhone } from "../phone/phone"
import type { Platform } from "../phone/platform"
import { secureRandom } from "../phone/random"
import type { Phone } from "../phone/types"
import { invalidHost, openWebSocket } from "../phone/websocket"
import { isWebSocket } from "../transport/address"
import { openAudio } from "./audio"
import { debugOutput } from "./debug"
import { localAddressTowards, openLink } from "./links"

/**
 * Registers a phone with your SIP server and resolves once it's online. After that it re-registers
 * and reconnects on its own. The URL looks like `tls://user:password@host[:port]`, `udp://…` or
 * `wss://user:password@host[:port][/path]`, with special characters in the password percent-encoded.
 * Browsers take only `wss://`, on a secure page, and ask for the microphone on the first call or
 * answer; behind NAT, give them `iceServers`.
 *
 * @example
 * ```ts
 * const phone = await connect("tls://alice:secret@sip.example.com")
 * ```
 * @example
 * ```ts
 * const phone = await connect(process.env.SIP_URL, { maxCalls: 20 })
 * ```
 * @throws {ConnectError} when the server cannot be reached or refuses the registration
 * @throws {TypeError} for a malformed URL, or when `url` is `undefined`
 * @throws {DOMException} in a browser that can't make calls, or on a page that isn't secure
 */
export function connect(url: string | undefined, options?: ConnectUrlOptions): Promise<Phone>
/**
 * Same, with options instead of a URL. Useful when the server isn't at your SIP domain.
 *
 * @example
 * ```ts
 * const phone = await connect({
 *   uri: "sip:+442079460456@sip.example.com",
 *   password: process.env.SIP_PASSWORD,
 *   server: "tls://edge.example.com",
 * })
 * ```
 */
export function connect(options: ConnectOptions): Promise<Phone>
export async function connect(
  target: string | ConnectOptions | undefined,
  options?: ConnectUrlOptions,
): Promise<Phone> {
  const settings = resolveOptions(target, options)
  const { phone } = await connectPhone(settings, nodePlatform(settings))
  return phone
}

export function nodePlatform(settings: PhoneSettings): Platform {
  const { server, tls, localPort: port } = settings
  if (!isWebSocket(server.transport)) {
    return {
      connect: (signal) => openLink(server, { tls, port }, signal),
      openAudio,
      debug: debugOutput(),
    }
  }
  // One name for the phone's life, so a new connection registers the same Contact
  const host = invalidHost(secureRandom)
  return {
    connect: (signal) => openWebSocket(server, host, signal),
    openAudio: async (_, silent) =>
      openAudio(await localAddressTowards(server.host, server.port), silent),
    debug: debugOutput(),
  }
}
