import { describe, expect, it } from "vitest"
import { createResponse, isRequest } from "../../src"
import { parsed, register } from "../helpers"

const request = parsed(register)
if (!isRequest(request)) throw new Error("Expected a request")

describe("createResponse", () => {
  it("copies the transaction and dialog fields", () => {
    expect(createResponse(request, 200, "OK")).toEqual({
      status: 200,
      reason: "OK",
      via: request.via,
      from: request.from,
      to: request.to,
      callId: request.callId,
      cseq: request.cseq,
      contact: [],
      headers: [],
      body: new Uint8Array(),
    })
  })

  it("adds a To tag when the request has none", () => {
    const response = createResponse(request, 200, "OK", { toTag: "abc" })
    expect(response.to.params.get("tag")).toBe("abc")
    expect(request.to.params.has("tag")).toBe(false)
  })

  it("replaces a To tag without value", () => {
    const flagged = { ...request, to: { ...request.to, params: new Map([["tag", null]]) } }
    expect(createResponse(flagged, 200, "OK", { toTag: "abc" }).to.params.get("tag")).toBe("abc")
  })

  it("keeps an existing To tag", () => {
    const tagged = { ...request, to: { ...request.to, params: new Map([["tag", "old"]]) } }
    expect(createResponse(tagged, 200, "OK", { toTag: "new" }).to.params.get("tag")).toBe("old")
  })

  it("adds extra headers", () => {
    const headers = [{ name: "Allow", value: "OPTIONS" }]
    expect(createResponse(request, 405, "Method Not Allowed", { headers }).headers).toEqual(headers)
  })
})
