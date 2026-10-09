import { isIntegerIn } from "../../support/integer"
import { fail, show } from "../syntax"

export function parseMaxForwards(value: string): number {
  const hops = Number(value)
  if (!/^\d+$/.test(value) || !isMaxForwards(hops)) fail(`Invalid Max-Forwards ${show(value)}`)
  return hops
}

export function isMaxForwards(hops: number): boolean {
  return isIntegerIn(hops, 0, 255)
}
