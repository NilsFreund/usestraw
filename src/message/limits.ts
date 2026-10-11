import { fail } from "./syntax"

export const MAX_MESSAGE_SIZE = 65_535
export const MAX_HEADER_LINES = 256
export const MAX_VIAS = 70
export const MAX_CONTACTS = 256
export const MAX_PARAMS = 32
// RFC 3261 §8.1.1.6: a request starts out allowed 70 hops
export const MAX_FORWARDS = 70

export function atMost<T>(items: T[], limit: number, what: string): T[] {
  if (items.length > limit) fail(`Too many ${what} (limit ${limit})`)
  return items
}
