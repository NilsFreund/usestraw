import { type Random, randomInt } from "../support/random"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

export function randomToken(random: Random, length: number): string {
  let token = ""
  for (let i = 0; i < length; i++) token += ALPHABET.charAt(randomInt(random, ALPHABET.length))
  return token
}

export function createBranch(random: Random): string {
  return `z9hG4bK${randomToken(random, 16)}`
}

export function createTag(random: Random): string {
  return randomToken(random, 10)
}

export function createCallId(random: Random): string {
  return randomToken(random, 20)
}

// RFC 5626 §4.1 and RFC 9562 §5.4: a random UUID names this phone to the registrar for its lifetime
export function createInstanceId(random: Random): string {
  const digits = Array.from({ length: 32 }, (_, index) => {
    if (index === 12) return 4
    return index === 16 ? 8 + randomInt(random, 4) : randomInt(random, 16)
  })
  const hex = digits.map((digit) => digit.toString(16)).join("")
  const parts = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ]
  return `urn:uuid:${parts.join("-")}`
}

export function createCnonce(random: Random): string {
  return randomToken(random, 16)
}
