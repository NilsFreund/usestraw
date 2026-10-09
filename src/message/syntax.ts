export const TOKEN_CHARS = "[A-Za-z0-9.!%*_+`'~-]"
export const QUOTED_STRING: string = String.raw`"(?:[^"\\]|\\.)*"`

const TOKEN = new RegExp(`^${TOKEN_CHARS}+$`)
const CONTROL = /(?![\t\x80-\x9f])\p{Cc}/u
const LINE_BREAK = /[\r\n]/
const INVISIBLE = /[\x7f-\x9f\u2028\u2029]/g

export class ParseError extends Error {
  override readonly name = "ParseError"
}

export function fail(message: string): never {
  throw new ParseError(message)
}

export function show(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value)
  const text = json.replace(
    INVISIBLE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
  return text.length > 100 ? `${text.slice(0, 97)}...` : text
}

export function isText(value: unknown): value is string {
  return typeof value === "string"
}

export function isToken(value: string): boolean {
  return isText(value) && TOKEN.test(value)
}

export function hasControl(value: string): boolean {
  return CONTROL.test(value)
}

export function hasLineBreak(value: string): boolean {
  return LINE_BREAK.test(value)
}

export function hasRawControl(value: string): boolean {
  if (!isText(value)) return true
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i)
    if (char === "\\") {
      i++
      if (hasLineBreak(value.charAt(i))) return true
    } else if (hasControl(char)) return true
  }
  return false
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

export function splitOutside(value: string, separator: string): string[] {
  const parts: string[] = []
  let quoted = false
  let angled = false
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i)
    if (quoted) {
      if (char === "\\") i++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "<") angled = true
    else if (char === ">") angled = false
    else if (char === separator && !angled) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }
  if (quoted) fail("Unterminated quoted string")
  parts.push(value.slice(start))
  return parts
}

export function readQuoted(input: string, start: number): [text: string, end: number] {
  let text = ""
  for (let i = start + 1; i < input.length; i++) {
    const char = input.charAt(i)
    if (char === '"') return [text, i + 1]
    if (char === "\\") i++
    text += input.charAt(i)
  }
  return fail("Unterminated quoted string")
}

export function quote(text: string): string {
  if (hasLineBreak(text)) throw new TypeError(`Cannot quote line breaks in ${show(text)}`)
  let quoted = '"'
  for (const char of text) {
    const code = char.charCodeAt(0)
    const special = char === '"' || char === "\\" || (code < 0x20 && char !== "\t") || code === 0x7f
    quoted += special ? `\\${char}` : char
  }
  return `${quoted}"`
}
