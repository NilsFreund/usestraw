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

export function createCnonce(random: Random): string {
  return randomToken(random, 16)
}
