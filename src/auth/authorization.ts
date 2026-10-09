import { quote } from "../message/syntax"
import type { Credentials } from "./digest"

// RFC 7616 §3.4 and RFC 8760 §2.6: quoted username, realm, nonce, uri, response, cnonce and opaque
export function formatAuthorization(credentials: Credentials): string {
  const { username, realm, nonce, uri, response, algorithm, opaque, protection, userhash } =
    credentials
  const params = [
    `username=${quote(username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
    ...(algorithm === undefined ? [] : [`algorithm=${algorithm}`]),
    ...(protection === undefined
      ? []
      : [`qop=${protection.qop}`, `nc=${protection.nc}`, `cnonce=${quote(protection.cnonce)}`]),
    ...(opaque === undefined ? [] : [`opaque=${quote(opaque)}`]),
    ...(userhash ? ["userhash=true"] : []),
  ]
  return `Digest ${params.join(", ")}`
}
