import type { Random } from "../../core/types"
import type { LinkConditions } from "./conditions"
import { createCounter } from "./counter"
import { createSegment, type Segment } from "./segment"
import { validateConditions } from "./validate"

export interface Routes {
  segment(from: string, to: string): Segment
  set(from: string, to: string, conditions: LinkConditions | undefined): void
  block(from: string, to: string): void
  unblock(from: string, to: string): void
  blocked(from: string, to: string): boolean
}

export function createRoutes(internet: LinkConditions, stream: (label: string) => Random): Routes {
  validateConditions(internet)
  const segments = new Map<string, Segment>()
  const blocks = createCounter()

  function segment(from: string, to: string): Segment {
    return segments.get(`${from}>${to}`) ?? install(from, to, internet)
  }

  function set(from: string, to: string, conditions: LinkConditions | undefined): void {
    const route = `${from}>${to}`
    const existing = segments.get(route)
    const next = conditions ?? internet
    segments.set(
      route,
      existing ? existing.retune(next) : createSegment(next, stream(`internet:${route}`)),
    )
  }

  function install(from: string, to: string, conditions: LinkConditions): Segment {
    const route = `${from}>${to}`
    const created = createSegment(conditions, stream(`internet:${route}`))
    segments.set(route, created)
    return created
  }

  return {
    segment,
    set,
    block: (from, to) => blocks.add(`${from}>${to}`),
    unblock: (from, to) => blocks.remove(`${from}>${to}`),
    blocked: (from, to) => blocks.has(`${from}>${to}`),
  }
}
