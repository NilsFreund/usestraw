import {
  type ConnectOptions,
  type ConnectUrlOptions,
  type PhoneSettings,
  resolveOptions,
} from "../phone/options"
import { connectPhone } from "../phone/phone"
import type { Platform } from "../phone/platform"
import type { Phone } from "../phone/types"
import { openAudio } from "./audio"
import { debugOutput } from "./debug"
import { openLink } from "./links"

/**
 * Registers a phone with your SIP server and resolves once it's online. After that it re-registers
 * and reconnects on its own. The URL looks like `tls://user:password@host[:port]` or `udp://…`,
 * with special characters in the password percent-encoded.
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
 */
export function connect(url: string | undefined, options?: ConnectUrlOptions): Promise<Phone>
/**
 * Same, with options instead of a URL. Useful when the server isn't at your SIP domain.
 *
 * @example
 * ```ts
 * const phone = await connect({
 *   uri: "sip:+4930123456@sip.example.com",
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
  return {
    connect: (signal) => openLink(server, { tls, port }, signal),
    openAudio,
    debug: debugOutput(),
  }
}
