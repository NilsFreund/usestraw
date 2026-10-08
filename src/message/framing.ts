import { fail } from "./syntax"

const CR = 13
const LF = 10
const decoder = new TextDecoder("utf-8", { fatal: true })

export function splitHead(bytes: Uint8Array): [head: string, bodyStart: number] {
  let start = 0
  while (bytes[start] === CR || bytes[start] === LF) start++
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] !== LF) continue
    const next = bytes[i + 1] === CR ? i + 2 : i + 1
    if (bytes[next] !== LF) continue
    const end = bytes[i - 1] === CR ? i - 1 : i
    return [decode(bytes.subarray(start, end)), next + 1]
  }
  return fail("Missing empty line after headers")
}

export function sliceBody(
  bytes: Uint8Array,
  start: number,
  contentLength: string | undefined,
): Uint8Array {
  if (contentLength !== undefined && !/^\d+$/.test(contentLength)) {
    fail(`Invalid Content-Length "${contentLength}"`)
  }
  const end = contentLength === undefined ? bytes.length : start + Number(contentLength)
  if (end > bytes.length) fail("Content-Length exceeds message size")
  return new Uint8Array(bytes.subarray(start, end))
}

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    return fail("Invalid UTF-8 in headers")
  }
}
