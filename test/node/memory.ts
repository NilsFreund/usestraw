import type { TransportAddress } from "../../src"
import type { Link, LinkHandlers } from "../../src/node/links"
import { createRandom } from "../../src/simulation/random"
import { type Registrar, type RegistrarOptions, registrar } from "../registrar"

const local = { transport: "UDP", host: "192.0.2.10", port: 5060 } as const
const remote = { transport: "UDP", host: "192.0.2.20", port: 5060 } as const

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
}

export function memoryNetwork(options: RegistrarOptions = {}): MemoryNetwork {
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
      },
    },
  }
  return network
}
