import { isIntegerIn } from "../../support/integer"
import { isText } from "../syntax"

const IPV4 = "\\d{1,3}(?:\\.\\d{1,3}){3}"
const IPV6 = "[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*"
const ZONE = "(?:%[\\w.~-]+)?"
const NAME = "[A-Za-z0-9.-]+"

export const HOST_PATTERN: string = `\\[${IPV6}\\]|${NAME}`

const HOST = new RegExp(`^(?:${HOST_PATTERN})$`)
const IP = new RegExp(`^(?:${IPV4}|${IPV6}${ZONE}|\\[${IPV6}${ZONE}\\])$`)

export function isHost(host: string): boolean {
  return isText(host) && HOST.test(host)
}

export function isIp(host: string): boolean {
  return isText(host) && IP.test(host)
}

export function isSocketHost(host: string): boolean {
  return isIp(host) || isHost(host)
}

export function isPort(port: number): boolean {
  return isIntegerIn(port, 0, 65535)
}

export function bareHost(host: string): string {
  const unbracketed = host.startsWith("[") ? host.slice(1, -1) : host
  const zone = unbracketed.indexOf("%")
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone)
}

export function formatHost(host: string): string {
  const bare = bareHost(host)
  return bare.includes(":") ? `[${bare}]` : bare
}

export function sameHost(a: string, b: string): boolean {
  return bareHost(a).toLowerCase() === bareHost(b).toLowerCase()
}
