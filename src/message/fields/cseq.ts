import { fail, isToken } from "../syntax"

export interface CSeq {
  readonly seq: number
  readonly method: string
}

export function parseCSeq(value: string): CSeq {
  const match = /^(\d+)\s+(\S+)$/.exec(value)
  const seq = Number(match?.[1])
  const method = match?.[2] ?? ""
  if (!(seq <= 0xffffffff) || !isToken(method)) fail(`Invalid CSeq "${value}"`)
  return { seq, method }
}

export function formatCSeq(cseq: CSeq): string {
  return `${cseq.seq} ${cseq.method}`
}
