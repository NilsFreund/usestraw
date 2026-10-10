import type { SipHeader, SipRequest, SipResponse } from "./types"

/** Options for {@link createResponse}. */
export interface ResponseOptions {
  readonly toTag?: string | undefined
  readonly headers?: readonly SipHeader[] | undefined
}

/** Builds a response to `request`, copying the headers RFC 3261 §8.2.6 requires. */
export function createResponse(
  request: SipRequest,
  status: number,
  reason: string,
  options: ResponseOptions = {},
): SipResponse {
  const { toTag, headers = [] } = options
  const to =
    toTag === undefined || request.to.params.get("tag")
      ? request.to
      : { ...request.to, params: new Map([...request.to.params, ["tag", toTag]]) }
  return {
    status,
    reason,
    via: request.via,
    from: request.from,
    to,
    callId: request.callId,
    cseq: request.cseq,
    contact: [],
    headers,
    body: new Uint8Array(),
  }
}
