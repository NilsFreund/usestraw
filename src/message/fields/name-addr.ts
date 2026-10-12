import { fail, hasLineBreak, isText, isToken, quote, readQuoted, show } from "../syntax"
import { formatParams, isParams, type Params, parseParams } from "./params"
import { isUri } from "./uri"

/** A URI with an optional display name and header parameters, as in From, To and Contact. */
export interface NameAddr {
  readonly displayName?: string | undefined
  readonly uri: string
  readonly params: Params
}

export function parseNameAddr(input: string): NameAddr {
  const value = input.trim()
  if (value.startsWith('"')) {
    const [displayName, end] = readQuoted(value, 0)
    return angled(value.slice(end), displayName)
  }
  const delimiter = value.search(/[<;]/)
  if (value.charAt(delimiter) === "<") {
    const words = value.slice(0, delimiter).trim()
    if (words === "") return angled(value.slice(delimiter))
    const tokens = words.split(/\s+/)
    if (!tokens.every(isToken)) fail(`Invalid display name ${show(words)}`)
    return angled(value.slice(delimiter), tokens.join(" "))
  }
  const end = delimiter === -1 ? value.length : delimiter
  const uri = value.slice(0, end).trim()
  if (!isUri(uri) || /[,?]/.test(uri)) fail(`Invalid address ${show(uri)}`)
  return { uri, params: parseParams(value.slice(end)) }
}

export function isNameAddr(address: NameAddr): boolean {
  const { displayName = "", uri, params } = address
  return isUri(uri) && isText(displayName) && !hasLineBreak(displayName) && isParams(params)
}

export function formatNameAddr(address: NameAddr): string {
  const name = address.displayName === undefined ? "" : `${quote(address.displayName)} `
  return `${name}<${address.uri}>${formatParams(address.params)}`
}

function angled(input: string, displayName?: string): NameAddr {
  const rest = input.trimStart()
  const close = rest.indexOf(">")
  if (!rest.startsWith("<") || close === -1) fail(`Expected <uri> in ${show(input.trim())}`)
  const uri = rest.slice(1, close)
  if (!isUri(uri)) fail(`Invalid URI ${show(uri)}`)
  const params = parseParams(rest.slice(close + 1))
  return displayName === undefined ? { uri, params } : { displayName, uri, params }
}
