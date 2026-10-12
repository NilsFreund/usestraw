import { atMost, MAX_CONTACTS } from "../limits"
import { splitOutside } from "../syntax"
import { formatNameAddr, type NameAddr, parseNameAddr } from "./name-addr"

/** RFC 3261 §20.10: the Contact header's addresses, or `"*"` for all of them in a REGISTER. */
export type Contact = readonly NameAddr[] | "*"

export function parseContact(values: readonly string[]): Contact {
  if (values.length === 1 && values[0] === "*") return "*"
  const entries = values.flatMap((value) => splitOutside(value, ","))
  return atMost(entries, MAX_CONTACTS, "Contact entries").map(parseNameAddr)
}

export function formatContact(contact: Contact): string[] {
  return contact === "*" ? ["*"] : contact.map(formatNameAddr)
}
