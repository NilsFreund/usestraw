import type { Random } from "../../core/types"
import { between } from "../random"

export function corrupt(data: Uint8Array, random: Random): Uint8Array {
  const copy = new Uint8Array(data)
  if (copy.length === 0) return copy
  const view = new DataView(copy.buffer)
  const index = between(random, 0, copy.length - 1)
  view.setUint8(index, view.getUint8(index) ^ between(random, 1, 255))
  return copy
}
