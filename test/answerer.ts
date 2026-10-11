import type { Core, CoreCommand, CoreOutput, MediaAddress } from "../src/core"
import { earliest } from "../src/support/time"

export interface AnswererOptions {
  readonly answerAfter?: number
  readonly reject?: number
  readonly hangupAfter?: number
  readonly media?: MediaAddress
}

interface Pending {
  readonly at: number
  readonly command: CoreCommand
}

// Wraps a phone so it picks up, rejects or hangs up its incoming calls on a script
export function answerer(core: Core, options: AnswererOptions = {}): Core {
  const { answerAfter, reject, hangupAfter } = options
  const media = options.media ?? { host: "192.0.2.10", port: 40_000 }
  const live = new Set<string>()
  let pending: Pending[] = []

  function react(outputs: CoreOutput[], now: number): CoreOutput[] {
    for (const output of outputs) {
      if (output.type !== "event" || output.event.type !== "call") continue
      const { call, state } = output.event
      if (state === "incoming" && (answerAfter !== undefined || reject !== undefined)) {
        const command: CoreCommand =
          reject === undefined
            ? { type: "accept", call, media }
            : { type: "end", call, status: reject }
        pending.push({ at: now + (answerAfter ?? 0), command })
      }
      if (state === "live" && hangupAfter !== undefined && !live.has(call)) {
        live.add(call)
        pending.push({ at: now + hangupAfter, command: { type: "end", call } })
      }
    }
    return outputs
  }

  function handle(input: Parameters<Core["handle"]>[0], now: number): CoreOutput[] {
    const outputs = react(core.handle(input, now), now)
    if (input.type !== "timeout") return outputs
    const due = pending.filter((entry) => entry.at <= now)
    pending = pending.filter((entry) => entry.at > now)
    const commands = due.flatMap(({ command }) =>
      react(core.handle({ type: "command", command }, now), now),
    )
    return [...outputs, ...commands]
  }

  return {
    handle,
    nextDeadline: () => earliest([core.nextDeadline(), ...pending.map((entry) => entry.at)]),
  }
}
