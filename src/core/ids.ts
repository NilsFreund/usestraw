import type { Random } from "./types"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

export function randomToken(random: Random, length: number): string {
  let token = ""
  const last = ALPHABET.length - 1
  for (let i = 0; i < length; i++) {
    token += ALPHABET.charAt(Math.min(last, Math.floor(random() * ALPHABET.length)))
  }
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
