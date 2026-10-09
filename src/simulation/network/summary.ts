const CR = 13
const decoder = new TextDecoder()

export function summarize(data: Uint8Array): string {
  const end = data.indexOf(CR)
  return decoder.decode(end === -1 ? data : data.subarray(0, end))
}
