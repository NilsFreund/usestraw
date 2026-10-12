import { isIntegerIn } from "../../support/integer"
import { bareHost, IPV6_PATTERN, isIp } from "../../support/ip"
import { isText } from "../syntax"

const NAME = "[A-Za-z0-9.-]+"

export const HOST_PATTERN: string = `\\[${IPV6_PATTERN}\\]|${NAME}`

const HOST = new RegExp(`^(?:${HOST_PATTERN})$`)

export function isHost(host: string): boolean {
  return isText(host) && HOST.test(host)
}

export function isSocketHost(host: string): boolean {
  return isIp(host) || isHost(host)
}

export function isPort(port: number): boolean {
  return isIntegerIn(port, 0, 65535)
}

export function formatHost(host: string): string {
  const bare = bareHost(host)
  return bare.includes(":") ? `[${bare}]` : bare
}

export function sameHost(a: string, b: string): boolean {
  return bareHost(a).toLowerCase() === bareHost(b).toLowerCase()
}
