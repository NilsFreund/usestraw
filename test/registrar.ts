import {
  type Core,
  createResponse,
  getHeader,
  isRequest,
  type NameAddr,
  parseMessage,
  type Random,
  type SipHeader,
  type SipRequest,
  type SipResponse,
  serializeMessage,
} from "../src"
import { computeAuthorization } from "../src/auth/digest"
import { resolveOffer } from "../src/auth/offer"
import { parseAuthParams } from "../src/auth/params"
import { withReceived } from "../src/message/fields/via"
import { topVia } from "../src/transaction/keys"
import { replyAddress } from "../src/transport/routing"

export interface RegistrarOptions {
  readonly realm?: string
  readonly users?: Readonly<Record<string, string>>
  readonly algorithm?: string
  readonly qop?: boolean
  readonly proxy?: boolean
  readonly minExpires?: number
  readonly maxExpires?: number
  readonly nonceLifetime?: number
  readonly rewrite?: string
  readonly script?: readonly number[]
  readonly retryAfter?: number
  readonly optionsStatus?: number
}

export interface Registrar extends Core {
  readonly registers: readonly SipRequest[]
  readonly bindings: ReadonlyMap<string, number>
}

type Verdict = "ok" | "missing" | "stale"

export function registrar(options: RegistrarOptions = {}): (random: Random) => Registrar {
  const {
    realm = "example.com",
    users = { alice: "secret" },
    algorithm,
    qop = true,
    proxy = false,
    minExpires = 0,
    maxExpires = 3600,
    nonceLifetime = Number.POSITIVE_INFINITY,
    rewrite,
    script = [],
    retryAfter,
    optionsStatus = 200,
  } = options
  const [status, reason, challengeName, answerName] = proxy
    ? [407, "Proxy Authentication Required", "Proxy-Authenticate", "Proxy-Authorization"]
    : [401, "Unauthorized", "WWW-Authenticate", "Authorization"]
  return (random) => {
    const nonces = new Map<string, { issued: number; nc: number }>()
    const registers: SipRequest[] = []
    const bindings = new Map<string, number>()
    const answered = new Map<string, SipResponse>()
    let scripted = 0

    function respond(request: SipRequest, now: number): SipResponse {
      const tag = { toTag: "registrar" }
      const scriptedStatus = script[scripted++]
      if (scriptedStatus !== undefined) {
        const headers =
          retryAfter === undefined ? [] : [{ name: "Retry-After", value: String(retryAfter) }]
        return createResponse(request, scriptedStatus, "Scripted", { ...tag, headers })
      }
      const verdict = verify(request, now)
      if (verdict !== "ok") {
        return createResponse(request, status, reason, {
          ...tag,
          headers: [challenge(verdict === "stale", now)],
        })
      }
      const requested = Number(getHeader(request, "Expires") ?? maxExpires)
      if (requested > 0 && requested < minExpires) {
        const headers = [{ name: "Min-Expires", value: String(minExpires) }]
        return createResponse(request, 423, "Interval Too Brief", { ...tag, headers })
      }
      return {
        ...createResponse(request, 200, "OK", tag),
        contact: bind(request, Math.min(requested, maxExpires), now),
      }
    }

    function bind(request: SipRequest, granted: number, now: number): NameAddr[] {
      const contacts = request.contact === "*" ? [] : request.contact
      for (const contact of contacts) {
        const uri = rewrite ?? contact.uri
        const expires = Number(contact.params.get("expires") ?? granted)
        if (expires === 0) bindings.delete(uri)
        else bindings.set(uri, now + Math.min(expires, granted) * 1000)
      }
      return [...bindings].map(([uri, until]) => ({
        uri,
        params: new Map([["expires", String(Math.round((until - now) / 1000))]]),
      }))
    }

    function challenge(stale: boolean, now: number): SipHeader {
      const nonce = Math.floor(random() * 2 ** 48).toString(16)
      nonces.set(nonce, { issued: now, nc: 0 })
      const params = [
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        ...(algorithm ? [`algorithm=${algorithm}`] : []),
        ...(qop ? ['qop="auth"'] : []),
        ...(stale ? ["stale=true"] : []),
      ]
      return { name: challengeName, value: `Digest ${params.join(", ")}` }
    }

    function verify(request: SipRequest, now: number): Verdict {
      const header = getHeader(request, answerName)
      const params =
        header === undefined ? undefined : parseAuthParams(header.replace(/^Digest\s+/i, ""))
      const issued = nonces.get(params?.get("nonce") ?? "")
      const username = params?.get("username") ?? ""
      const password = users[username]
      if (!params || !issued || password === undefined) return "missing"
      if (now - issued.issued > nonceLifetime) return "stale"
      const nc = Number.parseInt(params.get("nc") ?? "1", 16)
      const echoed = params.get("uri") === request.uri && params.get("realm") === realm
      if (!echoed || params.get("algorithm") !== algorithm || (qop && nc <= issued.nc))
        return "missing"
      issued.nc = nc
      const nonce = params.get("nonce") ?? ""
      const challenged = {
        realm,
        nonce,
        ...(algorithm ? { algorithm } : {}),
        qop: qop ? ["auth"] : [],
        stale: false,
        userhash: false,
      }
      const offer = resolveOffer(challenged)
      if (!offer) return "missing"
      const client = { cnonce: params.get("cnonce") ?? "x", nc }
      const expected = computeAuthorization(offer, { username, password }, request, client).response
      return expected === params.get("response") ? "ok" : "missing"
    }

    return {
      registers,
      bindings,
      handle(input, now) {
        if (input.type !== "receive") return []
        const result = parseMessage(input.data)
        if (!result.ok || !isRequest(result.message)) return []
        const { from } = input
        const request = {
          ...result.message,
          via: result.message.via.map((via, index) =>
            index === 0 ? withReceived(via, from.host, from.port) : via,
          ),
        }
        const to = replyAddress(topVia(request), input.from)
        if (request.method === "OPTIONS") {
          const response = createResponse(request, optionsStatus, "OK")
          return [{ type: "send", data: serializeMessage(response), to }]
        }
        if (request.method !== "REGISTER") return []
        registers.push(request)
        const branch = topVia(request).params.get("branch") ?? ""
        const response = answered.get(branch) ?? respond(request, now)
        answered.set(branch, response)
        return [{ type: "send", data: serializeMessage(response), to }]
      },
      nextDeadline: () => undefined,
    }
  }
}
