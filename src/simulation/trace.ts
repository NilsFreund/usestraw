export interface TraceEntry {
  readonly sentAt: number
  readonly deliverAt: number | null
  readonly from: string
  readonly to: string
  readonly summary: string
}

const CR = 13
const decoder = new TextDecoder()

export function summarize(data: Uint8Array): string {
  const end = data.indexOf(CR)
  return decoder.decode(end === -1 ? data : data.subarray(0, end))
}

export function formatTrace(trace: readonly TraceEntry[]): string {
  return trace
    .map(({ sentAt, deliverAt, from, to, summary }) => {
      const arrival = deliverAt === null ? "lost" : `+${deliverAt - sentAt}ms`
      return `${String(sentAt).padStart(6)}ms  ${from} → ${to}  ${summary}  (${arrival})`
    })
    .join("\n")
}
