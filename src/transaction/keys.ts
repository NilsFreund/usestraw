import { bareHost } from "../message/fields/host"
import type { Via } from "../message/fields/via"
import type { SipMessage, SipRequest, SipResponse } from "../message/types"
import { defaultPort } from "../transport/address"

const MAGIC_COOKIE = "z9hG4bK"

export function topVia(message: SipMessage): Via {
  const [via] = message.via
  if (!via) throw new Error("Message has no Via")
  return via
}

export function clientKey(message: SipMessage): string {
  return `${topVia(message).params.get("branch") ?? ""}|${message.cseq.method}`
}

export function serverKey(request: SipRequest): string {
  const via = topVia(request)
  const branch = via.params.get("branch") ?? ""
  const method = request.method === "ACK" ? "INVITE" : request.method
  const sentBy = `${bareHost(via.host).toLowerCase()}:${via.port ?? defaultPort(via.transport)}`
  if (isModern(branch)) return `${branch}|${sentBy}|${method}`
  const fromTag = request.from.params.get("tag") ?? ""
  const toTag = request.to.params.get("tag") ?? ""
  const dialog = `${request.callId}|${fromTag}|${toTag}`
  return `rfc2543|${dialog}|${request.cseq.seq}|${method}|${sentBy}|${request.uri}`
}

export function serverKeys(request: SipRequest): string[] {
  const key = serverKey(request)
  if (request.method !== "ACK" || isModern(topVia(request).params.get("branch") ?? "")) return [key]
  const params = new Map([...request.to.params].filter(([name]) => name !== "tag"))
  return [key, serverKey({ ...request, to: { ...request.to, params } })]
}

export function acknowledges(ack: SipRequest, response: SipResponse): boolean {
  if (isModern(topVia(ack).params.get("branch") ?? "")) return true
  return ack.to.params.get("tag") === response.to.params.get("tag")
}

function isModern(branch: string): boolean {
  return branch.startsWith(MAGIC_COOKIE)
}
