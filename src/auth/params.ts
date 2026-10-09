import { hasControl, QUOTED_STRING, readQuoted, TOKEN_CHARS } from "../message/syntax"

// RFC 7235 §2.1: auth-param = token BWS "=" BWS ( token / quoted-string ), comma separated
const PARAM = new RegExp(
  `[\\s,]*(${TOKEN_CHARS}+)[ \\t]*=[ \\t]*(${QUOTED_STRING}|[^\\s",]+)[ \\t]*(?=,|$)`,
  "y",
)
const END = /[\s,]*$/y

export function parseAuthParams(input: string): ReadonlyMap<string, string> | undefined {
  const params = new Map<string, string>()
  const param = new RegExp(PARAM)
  const end = new RegExp(END)
  for (;;) {
    end.lastIndex = param.lastIndex
    if (end.test(input)) return params
    const match = param.exec(input)
    if (!match) return undefined
    const [, raw = "", quoted = ""] = match
    const name = raw.toLowerCase()
    const value = quoted.startsWith('"') ? readQuoted(quoted, 0)[0] : quoted
    if (params.has(name) || hasControl(value)) return undefined
    params.set(name, value)
  }
}
