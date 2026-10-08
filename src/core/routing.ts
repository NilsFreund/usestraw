import type { Via } from "../message/fields/via"
import type { Address } from "./types"

const DEFAULT_PORT = 5060

export function replyAddress(via: Via | undefined, from: Address): Address {
  if (from.transport !== "UDP" || via?.params.has("rport")) return from
  return { ...from, port: via?.port ?? DEFAULT_PORT }
}
