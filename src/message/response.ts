import type { Header, SipRequest, SipResponse } from "./types"

export interface ResponseOptions {
  readonly toTag?: string
  readonly headers?: readonly Header[]
}

export function createResponse(
  request: SipRequest,
  status: number,
  reason: string,
  options: ResponseOptions = {},
): SipResponse {
  const { toTag, headers = [] } = options
  const to =
    toTag === undefined || request.to.params.has("tag")
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
