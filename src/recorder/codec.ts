const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()
const CHUNK = 0x8000
const TAGS = ["$map", "$text", "$base64", "$number"]
const HEAD_END = /\r?\n\r?\n/
const SECRET_HEADER = /^(?:proxy-)?(?:authorization|authentication-info)$/i
const SECRET_LINE =
  /^((?:proxy-)?(?:authorization|authentication-info)[ \t]*:)((?:[^\r\n]|\r?\n[ \t])*)/gim
const SECRET_PARAM = /(\b(?:response|rspauth)[ \t]*=[ \t]*)(?:"[^"]*"|[^,\s]*)/gi

// RFC 7616 §3.4 response and §3.5 rspauth are hashes of the password, so recordings never keep them
export function maskSecrets(text: string): string {
  return text.replace(SECRET_PARAM, '$1"masked"')
}

export function encode(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
    const raw = this[key]
    if (raw instanceof Uint8Array) return encodeBytes(maskMessage(raw))
    if (raw instanceof Map) return { $map: [...raw] }
    if (typeof raw === "number" && (!Number.isFinite(raw) || Object.is(raw, -0))) {
      return { $number: String(raw === 0 ? "-0" : raw) }
    }
    if (isSecretHeader(raw)) return { ...raw, value: maskSecrets(raw.value) }
    return item
  })
}

export function decode(text: string): unknown {
  return JSON.parse(text, (_key, item: unknown) => {
    if (!isTagged(item)) return item
    if (item.$map) return new Map(item.$map)
    if (item.$text !== undefined) return encoder.encode(item.$text)
    if (item.$number !== undefined) return Number(item.$number)
    return decodeBase64(item.$base64 as string)
  })
}

interface Tagged {
  readonly $map?: [unknown, unknown][]
  readonly $text?: string
  readonly $base64?: string
  readonly $number?: string
}

function isTagged(item: unknown): item is Tagged {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false
  const keys = Object.keys(item)
  return keys.length === 1 && TAGS.includes(keys[0] as string)
}

function isSecretHeader(item: unknown): item is { name: string; value: string } {
  if (typeof item !== "object" || item === null) return false
  const { name, value } = item as { name?: unknown; value?: unknown }
  return typeof name === "string" && typeof value === "string" && SECRET_HEADER.test(name)
}

function maskMessage(bytes: Uint8Array): Uint8Array {
  const text = latin1(bytes)
  const end = text.search(HEAD_END)
  const head = end === -1 ? text : text.slice(0, end)
  const masked = head.replace(
    SECRET_LINE,
    (_line, name: string, rest: string) => name + maskSecrets(rest),
  )
  if (masked === head) return bytes
  return Uint8Array.from(masked + text.slice(head.length), (char) => char.charCodeAt(0))
}

function latin1(bytes: Uint8Array): string {
  let text = ""
  for (let start = 0; start < bytes.length; start += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(start, start + CHUNK))
  }
  return text
}

function encodeBytes(bytes: Uint8Array): { $text: string } | { $base64: string } {
  try {
    return { $text: decoder.decode(bytes) }
  } catch {
    return { $base64: btoa(latin1(bytes)) }
  }
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}
