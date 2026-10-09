import type { Latency, LinkConditions, Loss } from "./conditions"

export function validateConditions(conditions: LinkConditions): void {
  const { latency, spikes, loss, duplicate, corrupt, bandwidth, buffer, mtu } = conditions
  if (latency) validateLatency(latency)
  if (spikes) {
    probability("spikes.chance", spikes.chance)
    validateLatency(spikes.latency)
  }
  if (loss) validateLoss(loss)
  if (duplicate !== undefined) probability("duplicate", duplicate)
  if (corrupt !== undefined) probability("corrupt", corrupt)
  if (bandwidth !== undefined) positive("bandwidth", bandwidth)
  if (buffer !== undefined) {
    atLeast("buffer", buffer, 0)
    if (bandwidth === undefined) throw new RangeError("buffer requires a bandwidth")
  }
  if (mtu !== undefined) positive("mtu", mtu)
}

function validateLatency(latency: Latency): void {
  switch (latency.kind) {
    case "fixed":
      atLeast("latency", latency.ms, 0)
      break
    case "uniform":
      atLeast("latency.min", latency.min, 0)
      atLeast("latency.max", latency.max, latency.min)
      break
    case "normal":
      atLeast("latency.mean", latency.mean, 0)
      atLeast("latency.deviation", latency.deviation, 0)
  }
}

function validateLoss(loss: Loss): void {
  if (loss.kind === "random") {
    probability("loss.rate", loss.rate)
    return
  }
  atLeast("loss.rate", loss.rate, 0)
  atLeast("loss.length", loss.length, 1)
  const maximum = loss.length / (loss.length + 1)
  if (!(loss.rate <= maximum)) {
    const limit = maximum.toFixed(3)
    throw new RangeError(
      `loss.rate must be at most ${limit} for bursts of length ${loss.length}, got ${loss.rate}`,
    )
  }
}

function probability(name: string, value: number): void {
  if (!(value >= 0 && value <= 1))
    throw new RangeError(`${name} must be within [0, 1], got ${value}`)
}

function positive(name: string, value: number): void {
  if (!(value > 0)) throw new RangeError(`${name} must be positive, got ${value}`)
}

function atLeast(name: string, value: number, minimum: number): void {
  if (!(value >= minimum)) throw new RangeError(`${name} must be at least ${minimum}, got ${value}`)
}
