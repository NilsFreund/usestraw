import { isIntegerIn } from "../../support/integer"
import { fail, isToken, show } from "../syntax"

export interface CSeq {
  readonly seq: number
  readonly method: string
}

export function parseCSeq(value: string): CSeq {
  const match = /^(\d+)[ \t]+(\S+)$/.exec(value)
  const cseq = { seq: Number(match?.[1]), method: match?.[2] ?? "" }
  if (!isCSeq(cseq)) fail(`Invalid CSeq ${show(value)}`)
  return cseq
}

export function isCSeq(cseq: CSeq): boolean {
  return isIntegerIn(cseq.seq, 0, 0xffffffff) && isToken(cseq.method)
}

export function formatCSeq(cseq: CSeq): string {
  return `${cseq.seq} ${cseq.method}`
}
