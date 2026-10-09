import type { Agenda } from "../../support/agenda"
import type { Address } from "../../transport/address"
import { addressKey, sameAddress } from "./address"
import type { Host, Hosts } from "./hosts"
import type { Nats } from "./nats"
import type { Routes } from "./routes"
import type { Segment } from "./segment"
import type { Delivery, DropReason, Fate, Hop, PacketRecord } from "./types"

export interface PacketState extends PacketRecord {
  copies: number
  readonly fates: Fate[]
}

export interface Transit {
  readonly packet: PacketState
  readonly sender: string
  readonly receiver: string
  readonly source: Address
  readonly destination: Address
  readonly data: Uint8Array
  readonly corrupted: boolean
  readonly hop: Hop
  readonly origin: string | undefined
  readonly site?: string | undefined
}

export interface Fabric {
  readonly hosts: Hosts
  readonly nats: Nats
  readonly routes: Routes
  readonly agenda: Agenda<Transit>
}

export type Forwarding = (transit: Transit, now: number) => Delivery | undefined

export function createForwarding({ hosts, nats, routes, agenda }: Fabric): Forwarding {
  function advance(transit: Transit, now: number): Delivery | undefined {
    switch (transit.hop) {
      case "uplink":
        return across(transit, hosts.get(transit.sender), "up", "egress", now)
      case "egress":
        return egress(transit, now)
      case "internet":
        return internet(transit, now)
      case "ingress":
        return ingress(transit, now)
      case "downlink":
        return across(transit, hosts.get(transit.receiver), "down", "arrival", now)
      case "arrival":
        return arrive(transit, now)
    }
  }

  function across(transit: Transit, host: Host, side: "up" | "down", next: Hop, now: number) {
    if (host.offline) return drop(transit, "outage", now)
    return through(transit, host[side], next, now)
  }

  function through(transit: Transit, segment: Segment, next: Hop, now: number): undefined {
    const result = segment.traverse(transit.data, transit.packet.size, now)
    if (result.type === "dropped") return drop(transit, result.reason, now)
    transit.packet.copies += result.copies.length - 1
    for (const { at, data, corrupted } of result.copies) {
      agenda.push(at, { ...transit, data, corrupted: transit.corrupted || corrupted, hop: next })
    }
  }

  function egress(transit: Transit, now: number): Delivery | undefined {
    if (hosts.get(transit.sender).offline) return drop(transit, "outage", now)
    const { destination } = transit
    let source = transit.source
    for (let site = transit.origin; site !== undefined; site = nats.parent(site)) {
      if (inside(destination, site)) return proceed(transit, { source, site, hop: "ingress" }, now)
      const nat = nats.get(site)
      source = nat.outbound(source, destination, now)
      if (destination.host === nat.host) {
        return proceed(transit, { source, site: nats.parent(site), hop: "ingress" }, now)
      }
    }
    return proceed(transit, { source, hop: "internet" }, now)
  }

  function inside(destination: Address, site: string): boolean {
    return (
      hosts.find(destination, site) !== undefined || nats.at(destination.host, site) !== undefined
    )
  }

  function internet(transit: Transit, now: number): undefined {
    const { sender, destination, origin } = transit
    const from = origin === undefined ? sender : nats.outermost(origin)
    const to = nats.at(destination.host, undefined) ?? hosts.find(destination, undefined)?.id
    const site = to ?? addressKey(destination)
    if (routes.blocked(from, site)) return drop(transit, "outage", now)
    return through(transit, routes.segment(from, site), "ingress", now)
  }

  function ingress(transit: Transit, now: number): Delivery | undefined {
    let destination = transit.destination
    let site = transit.site
    for (
      let nat = nats.at(destination.host, site);
      nat !== undefined;
      nat = nats.at(destination.host, site)
    ) {
      const internal = nats.get(nat).inbound(destination, transit.source, now)
      if (!internal) return drop(transit, "nat", now)
      destination = internal
      site = nat
    }
    const receiver = hosts.find(destination, site)
    if (!receiver) return drop(transit, "unroutable", now)
    return proceed(transit, { destination, receiver: receiver.id, hop: "downlink" }, now)
  }

  function arrive(transit: Transit, now: number): Delivery | undefined {
    const receiver = hosts.get(transit.receiver)
    if (receiver.offline) return drop(transit, "outage", now)
    if (!sameAddress(receiver.address, transit.destination)) {
      return drop(transit, "unroutable", now)
    }
    const { packet, source, data, corrupted } = transit
    packet.fates.push({ type: "delivered", at: now, host: receiver.id, corrupted })
    return { host: receiver.id, from: source, data }
  }

  function proceed(transit: Transit, change: Partial<Transit>, now: number): Delivery | undefined {
    return advance({ ...transit, ...change }, now)
  }

  function drop(transit: Transit, reason: DropReason, now: number): undefined {
    transit.packet.fates.push({ type: "dropped", at: now, reason, hop: transit.hop })
  }

  return advance
}
