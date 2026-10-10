import { isRequest, type SipMessage, type SipRequest, type SipResponse } from "../message/types"
import { createAgenda } from "../support/agenda"
import type { Address } from "../transport/address"
import { acceptsResponse, replyAddress } from "../transport/routing"
import { createClientInvite } from "./client-invite"
import { createClientNonInvite } from "./client-non-invite"
import { clientKey, serverKey, serverKeys, topVia } from "./keys"
import { notify, send } from "./outputs"
import { createServerInvite } from "./server-invite"
import { createServerNonInvite } from "./server-non-invite"
import { defaultTimers, type TimerSettings, validateTimers } from "./timers"
import type { ClientTransaction, ServerTransaction, Transaction, TransactionOutput } from "./types"

export interface TransactionOptions {
  readonly local: Address
  readonly timers?: TimerSettings
}

export interface Transactions {
  send(request: SipRequest, to: Address, now: number): TransactionOutput[]
  respond(transaction: string, response: SipResponse, now: number): TransactionOutput[]
  receive(message: SipMessage, from: Address, now: number): TransactionOutput[]
  hasInvite(cancel: SipRequest): boolean
  abandon(request: SipRequest): void
  expire(now: number): TransactionOutput[]
  nextDeadline(): number | undefined
}

export function createTransactions(options: TransactionOptions): Transactions {
  const { local, timers = defaultTimers } = options
  validateTimers(timers)
  const clients = new Map<string, ClientTransaction>()
  const servers = new Map<string, ServerTransaction>()
  const schedule = createAgenda<Transaction<string>>()
  const scheduled = new Map<Transaction<string>, number>()

  function start(request: SipRequest, to: Address, now: number): TransactionOutput[] {
    if (request.method === "ACK") return [send(request, to)]
    const create = request.method === "INVITE" ? createClientInvite : createClientNonInvite
    const transaction = create(request, to, timers)
    if (clients.has(transaction.key))
      throw new Error(`Transaction ${transaction.key} already exists`)
    clients.set(transaction.key, transaction)
    return settle(transaction, transaction.start(now))
  }

  function respond(key: string, response: SipResponse, now: number): TransactionOutput[] {
    const transaction = servers.get(key)
    if (!transaction) throw new Error(`Unknown server transaction ${key}`)
    return settle(transaction, transaction.respond(response, now))
  }

  function receive(message: SipMessage, from: Address, now: number): TransactionOutput[] {
    if (isRequest(message)) return receiveRequest(message, from, now)
    const transaction = acceptsResponse(message, local)
      ? clients.get(clientKey(message))
      : undefined
    if (!transaction) return [notify({ type: "stray", response: message, from })]
    return settle(transaction, transaction.receive(message, from, now))
  }

  function receiveRequest(request: SipRequest, from: Address, now: number): TransactionOutput[] {
    const to = replyAddress(topVia(request), from)
    const existing = find(request)
    const acceptedAck = request.method === "ACK" && existing?.state === "accepted"
    if (existing && !acceptedAck) return settle(existing, existing.receive(request, to, now))
    if (request.method === "ACK") return [notify({ type: "request", request, from })]
    const create = request.method === "INVITE" ? createServerInvite : createServerNonInvite
    const transaction = create(request, to, timers)
    servers.set(transaction.key, transaction)
    const event = notify({ type: "request", request, from, transaction: transaction.key })
    return [...settle(transaction, transaction.start(now)), event]
  }

  function find(request: SipRequest): ServerTransaction | undefined {
    for (const key of serverKeys(request)) {
      const transaction = servers.get(key)
      if (transaction) return transaction
    }
    return undefined
  }

  function expire(now: number): TransactionOutput[] {
    const outputs: TransactionOutput[] = []
    for (let at = schedule.next(); at !== undefined && at <= now; at = schedule.next()) {
      const transaction = schedule.take(now)
      if (transaction && scheduled.get(transaction) === at) {
        scheduled.delete(transaction)
        outputs.push(...settle(transaction, transaction.expire(now)))
      }
    }
    return outputs
  }

  function nextDeadline(): number | undefined {
    for (let at = schedule.next(); at !== undefined; at = schedule.next()) {
      const transaction = schedule.peek()
      if (transaction && scheduled.get(transaction) === at) return at
      schedule.take(at)
    }
    return undefined
  }

  function settle(transaction: Transaction<string>, outputs: TransactionOutput[]) {
    if (transaction.state === "terminated") {
      clients.delete(transaction.key)
      servers.delete(transaction.key)
      scheduled.delete(transaction)
      return outputs
    }
    const at = transaction.nextDeadline()
    if (at === undefined) scheduled.delete(transaction)
    else if (scheduled.get(transaction) !== at) {
      scheduled.set(transaction, at)
      schedule.push(at, transaction)
    }
    return outputs
  }

  return {
    send: start,
    respond,
    receive,
    hasInvite: (cancel) => servers.has(serverKey({ ...cancel, method: "INVITE" })),
    abandon: (request) => {
      const transaction = clients.get(clientKey(request))
      clients.delete(clientKey(request))
      if (transaction) scheduled.delete(transaction)
    },
    expire,
    nextDeadline,
  }
}
