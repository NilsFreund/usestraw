export type Latency =
  | { readonly kind: "fixed"; readonly ms: number }
  | { readonly kind: "uniform"; readonly min: number; readonly max: number }
  | { readonly kind: "normal"; readonly mean: number; readonly deviation: number }

export type Loss =
  | { readonly kind: "random"; readonly rate: number }
  | { readonly kind: "burst"; readonly rate: number; readonly length: number }

export interface Spikes {
  readonly chance: number
  readonly latency: Latency
}

export interface LinkConditions {
  readonly latency?: Latency
  readonly spikes?: Spikes
  readonly loss?: Loss
  readonly duplicate?: number
  readonly corrupt?: number
  readonly bandwidth?: number
  readonly buffer?: number
  readonly mtu?: number
  readonly ordered?: boolean
  readonly down?: boolean
}

export interface AccessLink {
  readonly up: LinkConditions
  readonly down: LinkConditions
}

export type Access = LinkConditions | AccessLink

export const latency = {
  fixed: (ms: number): Latency => ({ kind: "fixed", ms }),
  uniform: (min: number, max: number): Latency => ({ kind: "uniform", min, max }),
  normal: (mean: number, deviation: number): Latency => ({ kind: "normal", mean, deviation }),
}

export const loss = {
  random: (rate: number): Loss => ({ kind: "random", rate }),
  burst: (rate: number, length: number): Loss => ({ kind: "burst", rate, length }),
}

export function accessLink(access: Access): AccessLink {
  return "up" in access ? access : { up: access, down: access }
}
