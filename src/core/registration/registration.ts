import { parseDeltaSeconds } from "../../message/fields/delta-seconds"
import type { NameAddr } from "../../message/fields/name-addr"
import { getHeader } from "../../message/headers"
import type { SipResponse } from "../../message/types"
import { clientKey } from "../../transaction/keys"
import type { TransportAddress } from "../../transport/address"
import { isReliable } from "../../transport/address"
import { createAuthenticator, type Trust } from "../authenticator"
import type { Identity } from "../requests"
import type { Credentials, RegistrationEvent, RegistrationFailure } from "../types"
import { createContact, grantedExpiry, listsBinding, publicAddress, refreshDelay } from "./binding"
import { createRegisterRequest, createRegistrant } from "./request"
import { isRetryable, retryDelay } from "./retry"
import type { RegisterIntent, Registration, RegistrationInput, RegistrationOutput } from "./types"

interface Attempt extends RegisterIntent {
  readonly raised?: boolean
  readonly stale?: NameAddr
  readonly moved?: boolean | undefined
}

export function createRegistration(
  identity: Identity,
  trust: Trust,
  credentials?: Credentials,
  instance?: string,
): Registration {
  const { random } = identity
  const authenticator = createAuthenticator(credentials, random)
  let registrant = createRegistrant(identity, instance)
  let reachable = identity.address
  let rewriting = true
  let seq = 0
  let pending: { readonly key: string; readonly attempt: Attempt } | undefined
  let queued: Attempt | undefined
  let scheduled: { readonly at: number; readonly attempt: Attempt } | undefined
  let bound: RegisterIntent | undefined
  let left: NameAddr | undefined
  let failures = 0

  function register(intent: RegisterIntent): RegistrationOutput[] {
    failures = 0
    return dispatch(intent)
  }

  function unregister(): RegistrationOutput[] {
    const latest = queued ?? pending?.attempt ?? scheduled?.attempt ?? bound
    return latest ? dispatch({ to: latest.to, registrar: latest.registrar, expires: 0 }) : []
  }

  // RFC 3261 §10.2: no new REGISTER before the previous one has a final response or timed out
  function dispatch(attempt: Attempt): RegistrationOutput[] {
    if (pending) {
      queued = attempt
      return []
    }
    authenticator.reset()
    const stale = left
    left = undefined
    return send(stale ? { ...attempt, stale, moved: true } : attempt)
  }

  function send(attempt: Attempt): RegistrationOutput[] {
    scheduled = undefined
    const { registrar, expires, to } = attempt
    const { stale } = attempt
    const request = createRegisterRequest(registrant, registrar, ++seq, expires, identity, stale)
    const authorized = {
      ...request,
      headers: [...request.headers, ...authenticator.authorize(request)],
    }
    pending = { key: clientKey(authorized), attempt }
    return [{ type: "send", request: authorized, to }]
  }

  function receive(input: RegistrationInput, now: number): RegistrationOutput[] {
    const message = input.type === "response" ? input.response : input.request
    if (pending?.key !== clientKey(message)) return []
    if (input.type === "response" && input.response.status < 200) return []
    const { attempt } = pending
    const next = queued
    pending = undefined
    queued = undefined
    if (input.type === "timeout") {
      return next ? dispatch(next) : fail(attempt, { reason: "timeout" }, now)
    }
    const { response } = input
    if (response.status === 401 || response.status === 407) {
      const failure = authenticator.challenge(response)
      return failure ? fail(next ?? attempt, failure, now) : send(next ?? attempt)
    }
    return next ? dispatch(next) : conclude(attempt, response, now)
  }

  function conclude(attempt: Attempt, response: SipResponse, now: number): RegistrationOutput[] {
    const { status } = response
    const minimum = parseDeltaSeconds(getHeader(response, "Min-Expires")) ?? 0
    // RFC 3261 §10.2.8: retry once with Min-Expires after 423 Interval Too Brief
    if (status === 423 && attempt.expires > 0 && !attempt.raised && minimum > attempt.expires) {
      return send({ ...attempt, expires: minimum, raised: true })
    }
    // RFC 5626 §4.2.1: an edge without outbound support gets a plain registration instead
    if (status === 439 && registrant.instance !== undefined) {
      registrant = { ...registrant, instance: undefined }
      return send(attempt)
    }
    if (status >= 300) {
      const sent = authenticator.answered().length > 0 ? { withCredentials: true as const } : {}
      const failure = { reason: "rejected", status, phrase: response.reason, ...sent } as const
      return fail(attempt, failure, now, response)
    }
    failures = 0
    if (attempt.expires === 0) {
      bound = undefined
      return [emit({ type: "registration", state: "unregistered" })]
    }
    const granted = grantedExpiry(response, registrant, attempt.expires)
    if (granted === 0) return fail(attempt, { reason: "not-bound" }, now)
    const answered = authenticator.answered()
    if (answered.length > 0) trust.learn(answered)
    bound = { to: attempt.to, registrar: attempt.registrar, expires: attempt.expires }
    const registered = emit({ type: "registration", state: "registered", expires: granted })
    if (attempt.stale && !listsBinding(response, registrant)) {
      return [registered, ...send({ ...bound })]
    }
    const seen = rewriting && !attempt.stale ? publicAddress(response, reachable) : undefined
    if (seen) {
      const stale = registrant.contact
      reachable = seen
      registrant = { ...registrant, contact: createContact(seen, identity.aor) }
      return [registered, ...send({ ...bound, stale })]
    }
    scheduled = { at: now + refreshDelay(granted, random), attempt: bound }
    return [registered]
  }

  function fail(
    attempt: Attempt,
    failure: RegistrationFailure,
    now: number,
    response?: SipResponse,
  ): RegistrationOutput[] {
    const { to, registrar, expires, stale, moved } = attempt
    // A refused NAT rewrite goes back to the old Contact for good; a refused move keeps the new one
    if (stale && failure.reason === "rejected" && !isRetryable(failure)) {
      if (!moved) {
        rewriting = false
        registrant = { ...registrant, contact: stale }
      }
      return send({ to, registrar, expires })
    }
    if (expires === 0 || !isRetryable(failure)) {
      if (expires === 0) bound = undefined
      return [emit({ type: "registration", state: "failed", failure })]
    }
    failures += 1
    const retryIn = retryDelay(failures, random, response)
    scheduled = {
      at: now + retryIn,
      attempt: { to, registrar, expires, ...(stale ? { stale, moved } : {}) },
    }
    return [emit({ type: "registration", state: "failed", failure, retryIn })]
  }

  // Without a registration, answers to OPTIONS show where calls have to come to
  function observe(response: SipResponse): void {
    const seen = seq === 0 ? publicAddress(response, reachable) : undefined
    if (!seen) return
    reachable = seen
    registrant = { ...registrant, contact: createContact(seen, identity.aor) }
  }

  // A new connection has a new port: the next REGISTER carries it and asks to drop the old Contact
  function move(address: TransportAddress): void {
    const contact = createContact(address, identity.aor)
    reachable = address
    // A WebSocket keeps its Contact, yet answers over the old connection can no longer arrive
    if (contact.uri === registrant.contact.uri && !isReliable(address)) return
    pending = undefined
    queued = undefined
    if (bound) left ??= registrant.contact
    if (left?.uri === contact.uri) left = undefined
    registrant = { ...registrant, contact }
  }

  function expire(now: number): RegistrationOutput[] {
    if (!scheduled || scheduled.at > now) return []
    return dispatch(scheduled.attempt)
  }

  return {
    get contact() {
      return registrant.contact
    },
    register,
    unregister,
    receive,
    observe,
    move,
    expire,
    nextDeadline: () => scheduled?.at,
  }
}

function emit(event: RegistrationEvent): RegistrationOutput {
  return { type: "event", event }
}
