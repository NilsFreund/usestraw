export type NatBehavior =
  | "endpoint-independent"
  | "address-dependent"
  | "address-and-port-dependent"

export type PortAllocation = "preserve" | "sequential" | "random"

export interface NatOptions {
  readonly host: string
  readonly mapping?: NatBehavior
  readonly filtering?: NatBehavior
  readonly timeout?: number
  readonly ports?: PortAllocation
  readonly refreshOnInbound?: boolean
}

export type NatType = "fullCone" | "restrictedCone" | "portRestrictedCone" | "symmetric"

export const natTypes: Readonly<Record<NatType, Pick<NatOptions, "mapping" | "filtering">>> = {
  fullCone: { mapping: "endpoint-independent", filtering: "endpoint-independent" },
  restrictedCone: { mapping: "endpoint-independent", filtering: "address-dependent" },
  portRestrictedCone: {
    mapping: "endpoint-independent",
    filtering: "address-and-port-dependent",
  },
  symmetric: { mapping: "address-and-port-dependent", filtering: "address-and-port-dependent" },
}
