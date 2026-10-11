import { computeAuthorization } from "../src/auth/digest"
import { resolveOffer } from "../src/auth/offer"
import { parseAuthParams } from "../src/auth/params"
import {
  type Core,
  type CoreOutput,
  createResponse,
  getHeader,
  isRequest,
  parseMessage,
  type Random,
  type SipRequest,
  type SipResponse,
  serializeMessage,
  type TransportAddress,
} from "../src/core"
import { createRequest } from "../src/core/requests"
import { topVia } from "../src/transaction/keys"
import { replyAddress } from "../src/transport/routing"
import { sdp } from "./helpers"

export interface CalleeOptions {
  readonly ring?: readonly number[]
  readonly ringAfter?: number
  readonly answer?: number
  readonly answerAfter?: number
  readonly forks?: number
  readonly sdp?: string
  readonly recordRoute?: readonly string[]
  readonly challenge?: 401 | 407
  readonly challengeBye?: 401 | 407
  readonly users?: Readonly<Record<string, string>>
  readonly hangupAfter?: number
  readonly holdAfter?: number
  readonly resumeAfter?: number
  readonly t1?: number
}

export interface Callee extends Core {
  readonly received: readonly SipRequest[]
  readonly acked: ReadonlySet<string>
  readonly sent: readonly SipMessage[]
}

type SipMessage = SipRequest | SipResponse

interface Timer {
  readonly at: number
  readonly run: (now: number) => CoreOutput[]
}

interface Answered {
  readonly invite: SipRequest
  readonly from: TransportAddress
  final?: SipResponse
  readonly finals: SipResponse[]
  readonly pending: Timer[]
}

const REALM = "example.com"

// A scriptable SIP callee for simulation tests: rings, answers, forks, challenges, cancels and hangs up
export function callee(options: CalleeOptions = {}): (random: Random) => Callee {
  const {
    ring = [100, 180],
    ringAfter = 0,
    answer = 200,
    answerAfter = 0,
    forks = 1,
    sdp: body = sdp({ formats: [0, 101] }),
    recordRoute = [],
    challenge,
    users = { alice: "secret" },
    hangupAfter,
    holdAfter,
    resumeAfter,
    challengeBye,
    t1 = 500,
  } = options
  return (random) => {
    const received: SipRequest[] = []
    const sent: SipMessage[] = []
    const acked = new Set<string>()
    let byeAnswered = false
    let seq = 0
    let dialog: SipRequest | undefined
    const finals = new Set<number>()
    const calls = new Map<string, Answered>()
    let timers: Timer[] = []
    const nonce = Math.floor(random() * 2 ** 48).toString(16)
    const self: TransportAddress = { transport: "UDP", host: "192.0.2.20", port: 5060 }
    const caller: TransportAddress = { transport: "UDP", host: "192.0.2.10", port: 5060 }

    function out(message: SipMessage, to: TransportAddress): CoreOutput {
      sent.push(message)
      return { type: "send", data: serializeMessage(message), to }
    }

    function later(at: number, run: (now: number) => CoreOutput[]): Timer {
      const timer = { at, run }
      timers.push(timer)
      return timer
    }

    function authorized(invite: SipRequest, kind = challenge): boolean {
      if (!kind) return true
      const name = kind === 407 ? "Proxy-Authorization" : "Authorization"
      const header = getHeader(invite, name)
      const params =
        header === undefined ? undefined : parseAuthParams(header.replace(/^Digest\s+/i, ""))
      const username = params?.get("username") ?? ""
      const password = users[username]
      if (!params || password === undefined || params.get("nonce") !== nonce) return false
      const offer = resolveOffer({
        realm: REALM,
        nonce,
        qop: ["auth"],
        stale: false,
        userhash: false,
      })
      if (!offer) return false
      const nc = Number.parseInt(params.get("nc") ?? "1", 16)
      const client = { cnonce: params.get("cnonce") ?? "", nc }
      const expected = computeAuthorization(offer, { username, password }, invite, client)
      return expected.response === params.get("response")
    }

    function onInvite(invite: SipRequest, from: TransportAddress, now: number): CoreOutput[] {
      const branch = topVia(invite).params.get("branch") ?? ""
      const known = calls.get(branch)
      const to = replyAddress(topVia(invite), from)
      if (known) {
        const last = known.final ?? known.finals.at(-1)
        return last ? [out(last, to)] : []
      }
      if (!authorized(invite)) {
        const name = challenge === 407 ? "Proxy-Authenticate" : "WWW-Authenticate"
        const status = challenge === 407 ? 407 : 401
        const value = `Digest realm="${REALM}", nonce="${nonce}", qop="auth"`
        const response = createResponse(invite, status, "Unauthorized", {
          toTag: "challenge",
          headers: [{ name, value }],
        })
        calls.set(branch, { invite, from, final: response, finals: [], pending: [] })
        return [out(response, to)]
      }
      const entry: Answered = { invite, from, finals: [], pending: [] }
      calls.set(branch, entry)
      const ringing = () =>
        ring.map((status) =>
          out(
            createResponse(invite, status, "Ringing", status === 100 ? {} : { toTag: "fork0" }),
            to,
          ),
        )
      const outputs = ringAfter === 0 ? ringing() : []
      if (ringAfter > 0) entry.pending.push(later(now + ringAfter, ringing))
      if (answer > 0) entry.pending.push(later(now + answerAfter, (at) => finish(entry, to, at)))
      return outputs
    }

    function finish(entry: Answered, to: TransportAddress, now: number): CoreOutput[] {
      if (answer >= 300) {
        entry.final = createResponse(entry.invite, answer, "Scripted", { toTag: "fork0" })
        retransmit(entry.final, to, now, t1)
        return [out(entry.final, to)]
      }
      const outputs: CoreOutput[] = []
      for (let index = 0; index < forks; index++) {
        const response = success(entry.invite, `fork${index}`)
        entry.finals.push(response)
        outputs.push(out(response, to))
        retransmit(response, to, now, t1)
      }
      return outputs
    }

    function success(invite: SipRequest, tag: string): SipResponse {
      const base = createResponse(invite, 200, "OK", {
        toTag: tag,
        headers: [
          ...recordRoute.map((value) => ({ name: "Record-Route", value })),
          { name: "Content-Type", value: "application/sdp" },
        ],
      })
      return {
        ...base,
        contact: [{ uri: `sip:bob@192.0.2.20:5060;${tag}`, params: new Map() }],
        body: new TextEncoder().encode(body),
      }
    }

    // RFC 3261 §13.3.1.4 and §17.2.1: finals are retransmitted with T1 doubling until the ACK arrives
    function retransmit(
      response: SipResponse,
      to: TransportAddress,
      now: number,
      interval: number,
    ): void {
      repeat(response, to, now, interval, () => acked.has(response.to.params.get("tag") ?? ""))
    }

    function repeat(
      message: SipMessage,
      to: TransportAddress,
      now: number,
      interval: number,
      done: () => boolean,
    ): void {
      later(now + interval, (at) => {
        if (done() || interval > 32 * t1) return []
        repeat(message, to, at, Math.min(interval * 2, 4000), done)
        return [out(message, to)]
      })
    }

    function onAck(ack: SipRequest, now: number): CoreOutput[] {
      const tag = ack.to.params.get("tag") ?? ""
      if (acked.has(tag) || tag === "challenge") return []
      acked.add(tag)
      if (tag !== "fork0") return []
      dialog = ack
      if (holdAfter !== undefined) later(now + holdAfter, (at) => [reinvite(ack, at, "sendonly")])
      if (resumeAfter !== undefined)
        later(now + resumeAfter, (at) => [reinvite(ack, at, "sendrecv")])
      if (hangupAfter !== undefined) later(now + hangupAfter, (at) => [hangup(ack, at)])
      return []
    }

    // RFC 3264 §8.4: the far end puts the call on hold and back with a re-INVITE in the same dialog
    function reinvite(ack: SipRequest, now: number, direction: string): CoreOutput {
      const number = ++seq
      const contact = [{ uri: "sip:bob@192.0.2.20:5060", params: new Map() }]
      const headers = [{ name: "Content-Type", value: "application/sdp" }]
      const fields = {
        from: ack.to,
        to: ack.from,
        callId: ack.callId,
        seq: number,
        contact,
        headers,
      }
      const request = {
        ...createRequest("INVITE", targetOf(ack), fields, {
          address: self,
          aor: "sip:bob@example.com",
          random,
        }),
        body: new TextEncoder().encode(sdp({ formats: [0, 101], direction, version: number + 1 })),
      }
      repeat(request, caller, now, t1, () => finals.has(number))
      return out(request, caller)
    }

    function confirm(response: SipResponse): CoreOutput[] {
      finals.add(response.cseq.seq)
      if (!dialog || response.status >= 300) return []
      const fields = {
        from: response.from,
        to: response.to,
        callId: response.callId,
        seq: response.cseq.seq,
      }
      const identity = { address: self, aor: "sip:bob@example.com", random }
      return [out(createRequest("ACK", targetOf(dialog), fields, identity), caller)]
    }

    function targetOf(ack: SipRequest): string {
      const target = ack.contact === "*" ? undefined : ack.contact[0]
      return target?.uri ?? ack.from.uri
    }

    function hangup(ack: SipRequest, now: number): CoreOutput {
      const bye = createRequest(
        "BYE",
        targetOf(ack),
        { from: ack.to, to: ack.from, callId: ack.callId, seq: ++seq },
        { address: self, aor: "sip:bob@example.com", random },
      )
      repeat(bye, caller, now, t1, () => byeAnswered)
      return out(bye, caller)
    }

    function onCancel(cancel: SipRequest, from: TransportAddress, now: number): CoreOutput[] {
      const to = replyAddress(topVia(cancel), from)
      const entry = calls.get(topVia(cancel).params.get("branch") ?? "")
      const ok = out(createResponse(cancel, 200, "OK", { toTag: "fork0" }), to)
      if (!entry || entry.final || entry.finals.length > 0) return [ok]
      timers = timers.filter((timer) => !entry.pending.includes(timer))
      entry.final = createResponse(entry.invite, 487, "Request Terminated", { toTag: "fork0" })
      retransmit(entry.final, to, now, t1)
      return [ok, out(entry.final, to)]
    }

    function answerBye(bye: SipRequest): SipResponse {
      if (!challengeBye || authorized(bye, challengeBye)) return createResponse(bye, 200, "OK")
      const name = challengeBye === 407 ? "Proxy-Authenticate" : "WWW-Authenticate"
      const value = `Digest realm="${REALM}", nonce="${nonce}", qop="auth"`
      return createResponse(bye, challengeBye, "Unauthorized", { headers: [{ name, value }] })
    }

    function handle(input: Parameters<Core["handle"]>[0], now: number): CoreOutput[] {
      if (input.type === "timeout") {
        const due = timers.filter((timer) => timer.at <= now)
        timers = timers.filter((timer) => timer.at > now)
        return due.flatMap((timer) => timer.run(now))
      }
      if (input.type !== "receive") return []
      const result = parseMessage(input.data)
      if (!result.ok) return []
      if (!isRequest(result.message)) {
        const { cseq, status } = result.message
        if (cseq.method === "BYE") byeAnswered = true
        return cseq.method === "INVITE" && status >= 200 ? confirm(result.message) : []
      }
      const request = result.message
      received.push(request)
      const to = replyAddress(topVia(request), input.from)
      switch (request.method) {
        case "INVITE":
          return onInvite(request, input.from, now)
        case "ACK":
          return onAck(request, now)
        case "CANCEL":
          return onCancel(request, input.from, now)
        case "BYE":
          return [out(answerBye(request), to)]
        default:
          return [out(createResponse(request, 200, "OK"), to)]
      }
    }

    return {
      received,
      sent,
      acked,
      handle,
      nextDeadline: () =>
        timers.length === 0 ? undefined : Math.min(...timers.map((timer) => timer.at)),
    }
  }
}
