import { describe, expect, it } from "vitest"
import { createAlarms } from "../../src/transaction/alarms"

describe("createAlarms", () => {
  it("reports the next alarm", () => {
    const alarms = createAlarms<"A" | "B">()
    expect(alarms.next()).toBeUndefined()
    alarms.set("A", 300)
    alarms.set("B", 100)
    expect(alarms.next()).toBe(100)
  })

  it("takes due alarms in time order and removes them", () => {
    const alarms = createAlarms<"A" | "B" | "C">()
    alarms.set("A", 300)
    alarms.set("B", 100)
    alarms.set("C", 900)
    expect(alarms.take(500)).toEqual(["B", "A"])
    expect(alarms.take(500)).toEqual([])
    expect(alarms.next()).toBe(900)
  })

  it("replaces and clears alarms", () => {
    const alarms = createAlarms<"A" | "B">()
    alarms.set("A", 100)
    alarms.set("A", 200)
    alarms.set("B", 50)
    alarms.clear("B", "A")
    expect(alarms.next()).toBeUndefined()
  })
})
