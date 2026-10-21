import { describe, expect, test } from "bun:test"
import { createRecoveryCoordinator } from "./recovery"

describe("createRecoveryCoordinator", () => {
  test("coalesces overlapping resume triggers", async () => {
    const calls: Array<{ reasons: string[]; force: boolean }> = []
    const recovery = createRecoveryCoordinator({
      delayMs: 0,
      run(input) {
        calls.push({ reasons: [...input.reasons], force: input.force })
      },
    })

    void recovery.trigger({ reason: "visibility" })
    void recovery.trigger({ reason: "focus", force: true })
    await recovery.flush()

    expect(calls).toEqual([{ reasons: ["visibility", "focus"], force: true }])
  })

  test("queues one more recovery while the previous run is active", async () => {
    const calls: string[][] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const recovery = createRecoveryCoordinator({
      delayMs: 0,
      async run(input) {
        calls.push([...input.reasons])
        if (calls.length === 1) await gate
      },
    })

    void recovery.trigger({ reason: "visibility" })
    const first = recovery.flush()
    void recovery.trigger({ reason: "online" })
    void recovery.trigger({ reason: "server-connected", force: true })
    void recovery.trigger({ reason: "global-disposed", force: true })
    release()
    await first
    await recovery.flush()

    expect(calls).toEqual([["visibility"], ["online", "server-connected", "global-disposed"]])
  })

  test("joins an active refresh on focus while preserving reconnect recovery", async () => {
    const calls: string[][] = []
    const gate = Promise.withResolvers<void>()
    const recovery = createRecoveryCoordinator({
      delayMs: 0,
      async run(input) {
        calls.push(input.reasons)
        if (calls.length === 1) await gate.promise
      },
    })
    void recovery.trigger({ reason: "visibility", force: true })
    const active = recovery.flush()
    void recovery.trigger({ reason: "focus", force: true })
    void recovery.trigger({ reason: "pageshow", force: true })
    gate.resolve()
    await active
    await recovery.flush()
    expect(calls).toEqual([["visibility"]])

    void recovery.trigger({ reason: "focus", force: true })
    await recovery.flush()
    expect(calls).toEqual([["visibility"], ["focus"]])
    recovery.dispose()
  })
})
