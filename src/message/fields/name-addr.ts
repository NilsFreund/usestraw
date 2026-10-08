import { fail, isToken, quote, readQuoted } from "../syntax"
import { formatParams, type Params, parseParams } from "./params"
import { isUri } from "./uri"

export interface NameAddr {
  readonly displayName?: string
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
    if (!tokens.every(isToken)) fail(`Invalid display name "${words}"`)
    return angled(value.slice(delimiter), tokens.join(" "))
  }
  const end = delimiter === -1 ? value.length : delimiter
  const uri = value.slice(0, end).trim()
  if (!isUri(uri) || /[,?]/.test(uri)) fail(`Invalid address "${uri}"`)
  return { uri, params: parseParams(value.slice(end)) }
}

export function formatNameAddr(address: NameAddr): string {
  const name = address.displayName === undefined ? "" : `${quote(address.displayName)} `
  return `${name}<${address.uri}>${formatParams(address.params)}`
}

function angled(input: string, displayName?: string): NameAddr {
  const rest = input.trimStart()
  const close = rest.indexOf(">")
  if (!rest.startsWith("<") || close === -1) fail(`Expected <uri> in "${input.trim()}"`)
  const uri = rest.slice(1, close)
  if (!isUri(uri)) fail(`Invalid URI "${uri}"`)
  const params = parseParams(rest.slice(close + 1))
  return displayName === undefined ? { uri, params } : { displayName, uri, params }
}
