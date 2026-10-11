import {
  createResponse,
  isRequest,
  type SipMessage,
  type SipRequest,
  type SipResponse,
  type TransportAddress,
} from "../../src/core"
import type { Transaction, TransactionOutput } from "../../src/transaction/types"
import { bob, parsed } from "../helpers"

export const udp: TransportAddress = bob
export const tcp: TransportAddress = { ...bob, transport: "TCP" }

export function request(
  method = "OPTIONS",
  branch = "z9hG4bKclient",
  extra: string[] = [],
): SipRequest {
  const message = parsed(
    [
      `${method} sip:bob@example.com SIP/2.0`,
      `Via: SIP/2.0/UDP 192.0.2.10:5060;branch=${branch};rport`,
      "Max-Forwards: 70",
      "From: <sip:alice@example.com>;tag=a1",
      "To: <sip:bob@example.com>",
      "Call-ID: call-1",
      `CSeq: 1 ${method}`,
      ...extra,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
  )
  if (!isRequest(message)) throw new Error("Expected a request")
  return message
}

export function response(to: SipRequest, status: number, toTag = "b1"): SipResponse {
  return createResponse(to, status, "Reason", { toTag })
}

export function sends(outputs: TransactionOutput[]): SipMessage[] {
  return outputs.flatMap((output) => (output.type === "send" ? [output.message] : []))
}

export function kinds(outputs: TransactionOutput[]): string[] {
  return outputs.map((output) => {
    if (output.type === "event") return output.event.type
    return "method" in output.message ? output.message.method : String(output.message.status)
  })
}

export function run(
  transaction: Transaction<string>,
  until: number = Number.POSITIVE_INFINITY,
): [number, string[]][] {
  const log: [number, string[]][] = []
  for (
    let at = transaction.nextDeadline();
    at !== undefined && at <= until;
    at = transaction.nextDeadline()
  ) {
    if (log.length === 1000) throw new Error("The transaction keeps firing")
    log.push([at, kinds(transaction.expire(at))])
  }
  return log
}
