import { formatAuthorization } from "../auth/authorization"
import { parseChallenge } from "../auth/challenge"
import { computeAuthorization } from "../auth/digest"
import type { Offer } from "../auth/offer"
import { selectOffer, weakestOffer } from "../auth/select"
import { getHeaders } from "../message/headers"
import type { SipHeader, SipRequest, SipResponse } from "../message/types"
import { createCnonce } from "./ids"
import type { AuthChallenge, AuthFailure, Credentials, Random } from "./types"

export interface Authenticator {
  challenge(response: SipResponse): AuthFailure | undefined
  authorize(request: SipRequest): SipHeader[]
  answered(): Answered[]
  reset(): void
}

export interface Answered {
  readonly realm: string
  readonly weakest: number
}

// Calls answer only the realms the registration answered, never weaker than the server offered
export interface Trust {
  readonly floors: ReadonlyMap<string, number>
  learn(answered: readonly Answered[]): void
}

export function createTrust(): Trust {
  let floors: ReadonlyMap<string, number> = new Map()
  return {
    get floors() {
      return floors
    },
    learn: (answered) => {
      floors = new Map(answered.map((answer) => [answer.realm, answer.weakest]))
    },
  }
}

interface RealmAnswer {
  readonly offer: Offer
  readonly weakest: number
  readonly cnonce: string
  readonly attempts: number
  nc: number
  sent: boolean
}

const MAX_ATTEMPTS = 3

export function createAuthenticator(
  credentials: Credentials | undefined,
  random: Random,
  trust?: Trust,
): Authenticator {
  const answers = new Map<string, RealmAnswer>()

  // RFC 3261 §22.2–22.3: 401 carries WWW-Authenticate, 407 carries Proxy-Authenticate
  function challenge(response: SipResponse): AuthFailure | undefined {
    if (!credentials) return { reason: "no-credentials" }
    const proxy = response.status === 407
    const kind = proxy ? "Proxy-Authorization" : "Authorization"
    const values = getHeaders(response, proxy ? "Proxy-Authenticate" : "WWW-Authenticate")
    const offer = selectOffer(values, floorsFor(credentials, trust))
    if (!offer) return { reason: "unsupported-challenge", offered: values.map(describe) }
    const previous = answers.get(kind)
    // RFC 3261 §22.1: credentials rejected without stale=true must not be sent again
    const rejected = previous?.sent && (!offer.challenge.stale || previous.attempts >= MAX_ATTEMPTS)
    if (rejected) return { reason: "unauthorized", status: response.status }
    const reuse = previous?.offer.challenge.nonce === offer.challenge.nonce ? previous : undefined
    answers.set(kind, {
      offer,
      weakest: weakestOffer(values, offer.challenge.realm),
      cnonce: reuse?.cnonce ?? createCnonce(random),
      attempts: (previous?.attempts ?? 0) + 1,
      nc: reuse?.nc ?? 0,
      sent: false,
    })
    return undefined
  }

  // RFC 7616 §3.4: the nonce count rises with every request sent under the same nonce
  function authorize(request: SipRequest): SipHeader[] {
    if (!credentials) return []
    return [...answers].map(([name, answer]) => {
      answer.nc += 1
      answer.sent = true
      const authorization = computeAuthorization(answer.offer, credentials, request, answer)
      return { name, value: formatAuthorization(authorization) }
    })
  }

  return {
    challenge,
    authorize,
    answered: () =>
      [...answers.values()]
        .filter((answer) => answer.sent)
        .map((answer) => ({ realm: answer.offer.challenge.realm, weakest: answer.weakest })),
    reset: () => answers.clear(),
  }
}

function floorsFor(
  credentials: Credentials,
  trust?: Trust,
): ReadonlyMap<string, number> | undefined {
  if (credentials.realm !== undefined) {
    return new Map([[credentials.realm, trust?.floors.get(credentials.realm) ?? 0]])
  }
  return trust && trust.floors.size > 0 ? trust.floors : undefined
}

function describe(value: string): AuthChallenge {
  const challenge = parseChallenge(value)
  if (!challenge) return { scheme: value.replace(/[ \t].*$/s, "") }
  return { scheme: "Digest", realm: challenge.realm, algorithm: challenge.algorithm ?? "MD5" }
}
