import { type Algorithm, findAlgorithm } from "./algorithms"
import type { Challenge } from "./challenge"

export type Qop = "auth" | "auth-int"

export interface Offer {
  readonly challenge: Challenge
  readonly algorithm: Algorithm
  readonly qop?: Qop
}

// RFC 8760 §2.6 item 8: a missing qop means "auth"; plain MD5 keeps RFC 2069 for legacy servers
export function resolveOffer(challenge: Challenge): Offer | undefined {
  const algorithm = findAlgorithm(challenge.algorithm)
  if (!algorithm) return undefined
  if (challenge.qop.length === 0) {
    const legacy = algorithm.name === "MD5" && !algorithm.session
    return legacy ? { challenge, algorithm } : { challenge, algorithm, qop: "auth" }
  }
  const qop = (["auth", "auth-int"] as const).find((value) => challenge.qop.includes(value))
  return qop && { challenge, algorithm, qop }
}
