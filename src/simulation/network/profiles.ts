import { type LinkConditions, latency, loss } from "./conditions"

export type ProfileName =
  | "perfect"
  | "lan"
  | "fiber"
  | "cable"
  | "dsl"
  | "office"
  | "wifi"
  | "badWifi"
  | "lte"
  | "mobile3g"
  | "satellite"
  | "congested"
  | "bufferbloat"
  | "fragmentHostile"

export const profiles: Readonly<Record<ProfileName, LinkConditions>> = {
  perfect: {},
  lan: { latency: latency.uniform(0, 1) },
  fiber: { latency: latency.normal(5, 1) },
  cable: { latency: latency.normal(12, 3), loss: loss.random(0.001) },
  dsl: { latency: latency.normal(20, 5), loss: loss.random(0.002), bandwidth: 1_000_000 },
  office: { latency: latency.normal(8, 2), loss: loss.random(0.001) },
  wifi: {
    latency: latency.normal(6, 3),
    spikes: { chance: 0.02, latency: latency.uniform(30, 150) },
    loss: loss.random(0.005),
  },
  badWifi: {
    latency: latency.normal(25, 15),
    spikes: { chance: 0.05, latency: latency.uniform(150, 600) },
    loss: loss.burst(0.05, 4),
    duplicate: 0.005,
  },
  lte: {
    latency: latency.normal(35, 12),
    spikes: { chance: 0.02, latency: latency.uniform(80, 300) },
    loss: loss.random(0.01),
    mtu: 1400,
  },
  mobile3g: {
    latency: latency.normal(110, 40),
    loss: loss.burst(0.03, 3),
    bandwidth: 384_000,
    buffer: 40_000,
  },
  satellite: { latency: latency.normal(280, 15), loss: loss.random(0.01) },
  congested: {
    latency: latency.normal(30, 10),
    loss: loss.random(0.01),
    bandwidth: 256_000,
    buffer: 4_000,
  },
  bufferbloat: { latency: latency.normal(10, 2), bandwidth: 256_000, buffer: 256_000 },
  fragmentHostile: { latency: latency.normal(15, 3), mtu: 1300 },
}
