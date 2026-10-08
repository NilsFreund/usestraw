const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"]+$/

export function isUri(value: string): boolean {
  return URI.test(value)
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
