import { fail, isToken, splitOutside } from "../syntax"

export type Params = ReadonlyMap<string, string | null>

const VALUE = /^(?:[A-Za-z0-9.!%*_+`'~:-]+|\[[0-9A-Fa-f:.]+\]|"(?:[^"\\]|\\.)*")$/

export function parseParams(input: string): Params {
  const params = new Map<string, string | null>()
  const rest = input.trim()
  if (rest === "") return params
  if (!rest.startsWith(";")) fail(`Unexpected "${rest}"`)
  for (const part of splitOutside(rest.slice(1), ";")) {
    const equals = part.indexOf("=")
    const name = (equals === -1 ? part : part.slice(0, equals)).trim().toLowerCase()
    const value = equals === -1 ? null : part.slice(equals + 1).trim()
    if (!isToken(name) || (value !== null && !VALUE.test(value))) {
      fail(`Invalid parameter "${part.trim()}"`)
    }
    params.set(name, value)
  }
  return params
}

export function formatParams(params: Params): string {
  let formatted = ""
  for (const [name, value] of params) formatted += value === null ? `;${name}` : `;${name}=${value}`
  return formatted
}
