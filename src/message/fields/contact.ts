import { splitOutside } from "../syntax"
import { formatNameAddr, type NameAddr, parseNameAddr } from "./name-addr"

export type Contact = readonly NameAddr[] | "*"

export function parseContact(values: readonly string[]): Contact {
  if (values.length === 1 && values[0] === "*") return "*"
  return values.flatMap((value) => splitOutside(value, ",")).map(parseNameAddr)
}

export function formatContact(contact: Contact): string[] {
  return contact === "*" ? ["*"] : contact.map(formatNameAddr)
}
