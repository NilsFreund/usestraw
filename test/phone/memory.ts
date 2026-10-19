import type { TransportAddress } from "../../src/core"
import { openAudio } from "../../src/node/audio"
import type { PhoneSettings } from "../../src/phone/options"
import { type PhoneHandle, startPhone } from "../../src/phone/phone"
import type { Link, LinkHandlers, Platform } from "../../src/phone/platform"
import type { Phone } from "../../src/phone/types"
import { createRandom } from "../../src/simulation/random"
import { type Registrar, type RegistrarOptions, registrar } from "../registrar"

export interface MemoryNetwork {
  readonly link: Link
  readonly registrar: Registrar
  readonly sent: number
  readonly destinations: readonly TransportAddress[]
  readonly closed: boolean
  online: boolean
  broken: boolean
  replace(options: RegistrarOptions): void
  inject(data: Uint8Array, from?: TransportAddress): void
  drop(error?: Error): void
}

export function memoryNetwork(
  options: RegistrarOptions = {},
  { stream = false }: { readonly stream?: boolean | "websocket" } = {},
): MemoryNetwork {
  const transport = stream === "websocket" ? "WSS" : stream ? "TLS" : "UDP"
  const local: TransportAddress = { transport, host: "192.0.2.10", port: 5060 }
  const remote: TransportAddress = { transport, host: "192.0.2.20", port: 5060 }
  let server = registrar(options)(createRandom(3))
  let handlers: LinkHandlers | undefined
  let sent = 0
  const destinations: TransportAddress[] = []
  let closed = false
  const inject = (data: Uint8Array, from: TransportAddress = remote) =>
    handlers?.receive(data, from)
  const network = {
    online: true,
    broken: false,
    get registrar() {
      return server
    },
    get sent() {
      return sent
    },
    destinations,
    get closed() {
      return closed
    },
    replace: (next: RegistrarOptions) => {
      server = registrar(next)(createRandom(4))
    },
    inject,
    drop: (error?: Error) => handlers?.close(error),
    link: {
      local,
      remote,
      peers: [remote.host],
      start: (next: LinkHandlers) => {
        handlers = next
      },
      send: (data: Uint8Array, to: TransportAddress) => {
        if (network.broken) throw new Error("The link broke")
        sent++
        destinations.push(to)
        if (!network.online) return
        const from = local
        for (const output of server.handle({ type: "receive", data, from }, performance.now())) {
          if (output.type === "send") queueMicrotask(() => inject(output.data))
        }
      },
      close: () => {
        closed = true
        if (stream) queueMicrotask(() => handlers?.close())
      },
    },
  }
  return network
}

export async function startOn(
  network: MemoryNetwork,
  settings: PhoneSettings,
  platform: Partial<Platform> = {},
): Promise<Phone & Pick<PhoneHandle, "ping">> {
  const { phone, ping } = await startPhone(network.link, settings, {
    connect: async () => network.link,
    openAudio: (host, silent) => openAudio(host, silent),
    ...platform,
  })
  return Object.assign(phone, { ping })
}
