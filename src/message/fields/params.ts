import { atMost, MAX_PARAMS } from "../limits"
import { fail, hasRawControl, isToken, QUOTED_STRING, show, splitOutside } from "../syntax"

/** Header or URI parameters by lowercase name; `null` for a parameter without a value. */
export type Params = ReadonlyMap<string, string | null>

const VALUE = new RegExp(
  String.raw`^(?:[A-Za-z0-9.!%*_+\`'~:-]+|\[[0-9A-Fa-f:.]+\]|${QUOTED_STRING})$`,
)

export function parseParams(input: string): Params {
  const params = new Map<string, string | null>()
  const rest = input.trim()
  if (rest === "") return params
  if (!rest.startsWith(";")) fail(`Unexpected ${show(rest)}`)
  for (const part of atMost(splitOutside(rest.slice(1), ";"), MAX_PARAMS, "parameters")) {
    const equals = part.indexOf("=")
    const name = (equals === -1 ? part : part.slice(0, equals)).trim().toLowerCase()
    const value = equals === -1 ? null : part.slice(equals + 1).trim()
    if (!isParam(name, value)) fail(`Invalid parameter ${show(part.trim())}`)
    params.set(name, value)
  }
  return params
}

export function isParams(params: Params): boolean {
  return [...params].every(([name, value]) => isParam(name, value))
}

export function formatParams(params: Params): string {
  let formatted = ""
  for (const [name, value] of params) formatted += value === null ? `;${name}` : `;${name}=${value}`
  return formatted
}

function isParam(name: string, value: string | null): boolean {
  return isToken(name) && (value === null || (VALUE.test(value) && !hasRawControl(value)))
}
