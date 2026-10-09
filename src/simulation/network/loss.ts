import type { Random } from "../../core/types"
import { chance } from "../random"
import type { Loss } from "./conditions"

export type LossModel = () => boolean

export function createLossModel(loss: Loss | undefined, random: Random): LossModel {
  if (loss === undefined) return () => false
  if (loss.kind === "random") return () => chance(random, loss.rate)
  const recover = 1 / loss.length
  const fail = (loss.rate * recover) / (1 - loss.rate)
  let bad = false
  return () => {
    bad = chance(random, bad ? 1 - recover : fail)
    return bad
  }
}
