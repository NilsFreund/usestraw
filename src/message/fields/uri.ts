const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"]+$/

export function isUri(value: string): boolean {
  return URI.test(value)
}

export function isRequestUri(value: string): boolean {
  return isUri(value) && !hasHeaders(value)
}

function hasHeaders(uri: string): boolean {
  return /^sips?:/i.test(uri) && uri.slice(uri.indexOf("@") + 1).includes("?")
}
