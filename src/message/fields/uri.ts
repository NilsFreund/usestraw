import { isText } from "../syntax"

const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\p{Cc}<>"]+$/u

export function isUri(value: string): boolean {
  return isText(value) && URI.test(value)
}

export function isSipUri(value: string): boolean {
  return /^sips?:/i.test(value)
}

export function isRequestUri(value: string): boolean {
  return isUri(value) && !hasHeaders(value)
}

function hasHeaders(uri: string): boolean {
  return isSipUri(uri) && uri.slice(uri.indexOf("@") + 1).includes("?")
}
