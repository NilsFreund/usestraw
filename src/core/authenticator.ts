import { formatAuthorization } from "../auth/authorization"
import { parseChallenge } from "../auth/challenge"
import { computeAuthorization } from "../auth/digest"
import type { Offer } from "../auth/offer"
import { selectOffer } from "../auth/select"
import { getHeaders } from "../message/headers"
import type { Header, SipRequest, SipResponse } from "../message/types"
import { createCnonce } from "./ids"
import type { AuthFailure, Credentials, OfferedChallenge, Random } from "./types"

export interface Authenticator {
  challenge(response: SipResponse): AuthFailure | undefined
  authorize(request: SipRequest): Header[]
  reset(): void
}

interface Answer {
  readonly offer: Offer
  readonly cnonce: string
  readonly attempts: number
  nc: number
  sent: boolean
}

const MAX_ATTEMPTS = 3

export function createAuthenticator(
  credentials: Credentials | undefined,
  random: Random,
): Authenticator {
  const answers = new Map<string, Answer>()

  // RFC 3261 §22.2–22.3: 401 carries WWW-Authenticate, 407 carries Proxy-Authenticate
  function challenge(response: SipResponse): AuthFailure | undefined {
    if (!credentials) return { reason: "no-credentials" }
    const proxy = response.status === 407
    const kind = proxy ? "Proxy-Authorization" : "Authorization"
    const values = getHeaders(response, proxy ? "Proxy-Authenticate" : "WWW-Authenticate")
    const offer = selectOffer(values, credentials.realm)
    if (!offer) return { reason: "unsupported-challenge", offered: values.map(describe) }
    const previous = answers.get(kind)
    // RFC 3261 §22.1: credentials rejected without stale=true must not be sent again
    const rejected = previous?.sent && (!offer.challenge.stale || previous.attempts >= MAX_ATTEMPTS)
    if (rejected) return { reason: "unauthorized", status: response.status }
    const reuse = previous?.offer.challenge.nonce === offer.challenge.nonce ? previous : undefined
    answers.set(kind, {
      offer,
      cnonce: reuse?.cnonce ?? createCnonce(random),
      attempts: (previous?.attempts ?? 0) + 1,
      nc: reuse?.nc ?? 0,
      sent: false,
    })
    return undefined
  }

  // RFC 7616 §3.4: the nonce count rises with every request sent under the same nonce
  function authorize(request: SipRequest): Header[] {
    if (!credentials) return []
    return [...answers].map(([name, answer]) => {
      answer.nc += 1
      answer.sent = true
      const authorization = computeAuthorization(answer.offer, credentials, request, answer)
      return { name, value: formatAuthorization(authorization) }
    })
  }

  return { challenge, authorize, reset: () => answers.clear() }
}

function describe(value: string): OfferedChallenge {
  const challenge = parseChallenge(value)
  if (!challenge) return { scheme: value.replace(/[ \t].*$/s, "") }
  return { scheme: "Digest", realm: challenge.realm, algorithm: challenge.algorithm ?? "MD5" }
}
