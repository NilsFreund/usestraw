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
import { openWebSocket } from "../phone/websocket"
import { isWebSocket } from "../transport/address"
import { webDebug } from "./debug"
import { browserLocks, browserStorage, identityFor } from "./identity"
import { browserMedia, openPeerAudio, type WebMedia } from "./peer"

/**
 * Registers a phone with your SIP server over WebSocket and resolves once it's online. Calls use
 * the microphone and the speakers, asked for on the first call or answer.
 *
 * @example
 * ```ts
 * const phone = await connect("wss://alice:secret@pbx.example.com/ws")
 * ```
 * @throws {ConnectError} when the server cannot be reached or refuses the registration
 * @throws {TypeError} for a malformed URL or a server that is not `wss://` (`ws://` on localhost)
 * @throws {DOMException} in a browser that can't make calls, or on a page that isn't secure
 */
export function connect(url: string | undefined, options?: ConnectUrlOptions): Promise<Phone>
export function connect(options: ConnectOptions): Promise<Phone>
export async function connect(
  target: string | ConnectOptions | undefined,
  options?: ConnectUrlOptions,
): Promise<Phone> {
  const settings = resolveOptions(target, options)
  const platform = await webPlatform(settings)
  try {
    const { phone } = await connectPhone(settings, platform)
    // Once this phone unregistered, the next one in the tab may take the saved identity
    const stop = phone.subscribe(() => {
      if (phone.status !== "closed") return
      stop()
      platform.release()
    })
    return phone
  } catch (error) {
    platform.release()
    throw error
  }
}

export async function webPlatform(
  settings: PhoneSettings,
  media: WebMedia = browserMedia(),
  storage: Storage | undefined = browserStorage(),
  locks: LockManager | undefined = browserLocks(),
): Promise<Platform & { readonly release: () => void }> {
  const { server, iceServers = [] } = settings
  if (!isWebSocket(server.transport)) {
    throw new TypeError(
      "Browsers reach SIP only over WebSocket: use wss://user:password@host[:port][/path]",
    )
  }
  const { host, instance, release } = await identityFor(storage, locks, secureRandom)
  return {
    connect: (signal) => openWebSocket(server, host, signal),
    openAudio: (_, silent, options) =>
      openPeerAudio(media, iceServers as RTCIceServer[], silent, options),
    debug: webDebug(storage),
    media: "sdp",
    instance,
    release,
  }
}
