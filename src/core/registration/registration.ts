import { parseDeltaSeconds } from "../../message/fields/delta-seconds"
import { getHeader } from "../../message/headers"
import type { SipResponse } from "../../message/types"
import { clientKey } from "../../transaction/keys"
import { createAuthenticator, type Trust } from "../authenticator"
import type { Identity } from "../requests"
import type { Credentials, RegistrationEvent, RegistrationFailure } from "../types"
import { grantedExpiry, refreshDelay } from "./binding"
import { createRegisterRequest, createRegistrant } from "./request"
import { isRetryable, retryDelay } from "./retry"
import type { RegisterIntent, Registration, RegistrationInput, RegistrationOutput } from "./types"

interface Attempt extends RegisterIntent {
  readonly raised?: boolean
}

export function createRegistration(
  identity: Identity,
  trust: Trust,
  credentials?: Credentials,
): Registration {
  const { random } = identity
  const authenticator = createAuthenticator(credentials, random)
  const registrant = createRegistrant(identity)
  let seq = 0
  let pending: { readonly key: string; readonly attempt: Attempt } | undefined
  let queued: Attempt | undefined
  let scheduled: { readonly at: number; readonly attempt: Attempt } | undefined
  let bound: RegisterIntent | undefined
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
    return send(attempt)
  }

  function send(attempt: Attempt): RegistrationOutput[] {
    scheduled = undefined
    const { registrar, expires, to } = attempt
    const request = createRegisterRequest(registrant, registrar, ++seq, expires, identity)
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
    if (input.type === "timeout")
      return next ? dispatch(next) : fail(attempt, { reason: "timeout" }, now)
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
    if (status >= 300) {
      return fail(attempt, { reason: "rejected", status, phrase: response.reason }, now, response)
    }
    failures = 0
    if (attempt.expires === 0) {
      bound = undefined
      return [notify({ type: "registration", state: "unregistered" })]
    }
    const granted = grantedExpiry(response, registrant.contact, attempt.expires)
    if (granted === 0) return fail(attempt, { reason: "not-bound" }, now)
    const answered = authenticator.answered()
    if (answered.length > 0) trust.learn(answered)
    bound = { to: attempt.to, registrar: attempt.registrar, expires: attempt.expires }
    scheduled = { at: now + refreshDelay(granted, random), attempt: bound }
    return [notify({ type: "registration", state: "registered", expires: granted })]
  }

  function fail(
    attempt: Attempt,
    failure: RegistrationFailure,
    now: number,
    response?: SipResponse,
  ): RegistrationOutput[] {
    if (attempt.expires === 0 || !isRetryable(failure)) {
      if (attempt.expires === 0) bound = undefined
      return [notify({ type: "registration", state: "failed", failure })]
    }
    failures += 1
    const retryIn = retryDelay(failures, random, response)
    scheduled = {
      at: now + retryIn,
      attempt: { to: attempt.to, registrar: attempt.registrar, expires: attempt.expires },
    }
    return [notify({ type: "registration", state: "failed", failure, retryIn })]
  }

  function expire(now: number): RegistrationOutput[] {
    if (!scheduled || scheduled.at > now) return []
    return dispatch(scheduled.attempt)
  }

  return { register, unregister, receive, expire, nextDeadline: () => scheduled?.at }
}

function notify(event: RegistrationEvent): RegistrationOutput {
  return { type: "event", event }
}
