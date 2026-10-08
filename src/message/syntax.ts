const TOKEN = /^[A-Za-z0-9.!%*_+`'~-]+$/

export class ParseError extends Error {
  override readonly name = "ParseError"
}

export function fail(message: string): never {
  throw new ParseError(message)
}

export function isToken(value: string): boolean {
  return TOKEN.test(value)
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
  let quoted = '"'
  for (const char of text) {
    const code = char.charCodeAt(0)
    const special = char === '"' || char === "\\" || code < 0x20 || code === 0x7f
    quoted += special ? `\\${char}` : char
  }
  return `${quoted}"`
}
