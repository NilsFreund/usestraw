import { isText } from "../syntax"

export interface SipUriParts {
  readonly scheme: string
  readonly user?: string
  readonly hostport: string
}

const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\p{Cc}<>"]+$/u
const SIP_URI = /^(sips?):(?:([^@]*)@)?([^;?]*)/i

export function isUri(value: string): boolean {
  return isText(value) && URI.test(value)
}

export function isSipUri(value: string): boolean {
  return /^sips?:/i.test(value)
}

export function isRequestUri(value: string): boolean {
  return isUri(value) && !hasHeaders(value)
}

export function splitSipUri(uri: string): SipUriParts | undefined {
  const [, scheme, user, hostport = ""] = SIP_URI.exec(uri) ?? []
  if (scheme === undefined) return undefined
  return { scheme: scheme.toLowerCase(), ...(user === undefined ? {} : { user }), hostport }
}

function hasHeaders(uri: string): boolean {
  return isSipUri(uri) && uri.slice(uri.indexOf("@") + 1).includes("?")
}
