import { parseChallenge } from "./challenge"
import { type Offer, resolveOffer } from "./offer"

// RFC 8760 §2.4: answer one realm; local policy takes its strongest offer instead of the topmost
export function selectOffer(values: readonly string[], realm?: string): Offer | undefined {
  const offers = values.flatMap((value) => {
    const challenge = parseChallenge(value)
    const offer = challenge && resolveOffer(challenge)
    return offer ? [offer] : []
  })
  const wanted = realm ?? offers[0]?.challenge.realm
  let best: Offer | undefined
  for (const offer of offers) {
    if (offer.challenge.realm === wanted && (!best || strength(offer) > strength(best)))
      best = offer
  }
  return best
}

function strength(offer: Offer): number {
  return offer.algorithm.strength * 2 + (offer.qop === undefined ? 0 : 1)
}
