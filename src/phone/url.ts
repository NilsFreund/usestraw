export interface UrlFields {
  readonly uri: string
  readonly server: string
  readonly user: string
  readonly password?: string
}

const SIP_USER = /[^\w\-.!~*'()&=+$,;?/]/gu

export function parseConnectionUrl(url: string): UrlFields {
  const parsed = URL.canParse(url) ? new URL(url) : undefined
  // The host is left out: with a # ? or / in the password, what URL calls the host is part of it
  const invalid = new TypeError(
    "Invalid connection URL: use tls://user:password@host[:port], with % # ? / in the password percent-encoded",
  )
  const scheme = parsed?.protocol.slice(0, -1)
  if (!parsed || (scheme !== "udp" && scheme !== "tls")) throw invalid
  if (!parsed.username || parsed.pathname || parsed.search || parsed.hash) throw invalid
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      throw invalid
    }
  }
  const user = decode(parsed.username)
  const port = parsed.port ? `:${parsed.port}` : ""
  return {
    uri: `sip:${user.replace(SIP_USER, encodeURIComponent)}@${parsed.hostname}`,
    server: `${scheme}://${parsed.hostname}${port}`,
    user,
    ...(parsed.password ? { password: decode(parsed.password) } : {}),
  }
}
