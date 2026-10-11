import { parseChallenge } from "./challenge"
import { type Offer, resolveOffer } from "./offer"

// RFC 8760 §2.4: answer one realm; local policy takes its strongest offer instead of the topmost,
// and only realms in `floors`, none weaker than the realm's floor
export function selectOffer(
  values: readonly string[],
  floors?: ReadonlyMap<string, number>,
): Offer | undefined {
  const offers = offersOf(values)
  const wanted = offers.find((offer) => !floors || floors.has(offer.challenge.realm))?.challenge
    .realm
  const minimum = (wanted !== undefined && floors?.get(wanted)) || 0
  let best: Offer | undefined
  for (const offer of offers) {
    if (offer.challenge.realm !== wanted || strength(offer) < minimum) continue
    if (!best || strength(offer) > strength(best)) best = offer
  }
  return best
}

export function weakestOffer(values: readonly string[], realm: string): number {
  const strengths = offersOf(values)
    .filter((offer) => offer.challenge.realm === realm)
    .map(strength)
  return Math.min(...strengths)
}

function offersOf(values: readonly string[]): Offer[] {
  return values.flatMap((value) => {
    const challenge = parseChallenge(value)
    const offer = challenge && resolveOffer(challenge)
    return offer ? [offer] : []
  })
}

function strength(offer: Offer): number {
  return offer.algorithm.strength * 2 + (offer.qop === undefined ? 0 : 1)
}
