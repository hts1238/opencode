import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { SharedTask } from "@opencode-ai/core/effect/shared-task"
import { it } from "../lib/effect"

it.effect("shares concurrent work and starts fresh work after completion", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls: string[] = []
    const run = yield* SharedTask.make((key: string) =>
      Effect.gen(function* () {
        calls.push(key)
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return { key }
      }),
    )
    const first = yield* run("project").pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const second = yield* run("project").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.succeed(release, undefined)
    const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
    expect(results[0]).toBe(results[1])
    expect(calls).toEqual(["project"])
    expect(yield* run("project")).not.toBe(results[0])
    expect(calls).toEqual(["project", "project"])
  }),
)

it.effect("cancelling a waiter preserves shared work and unrelated keys run independently", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls: string[] = []
    const run = yield* SharedTask.make((key: string) =>
      Effect.gen(function* () {
        calls.push(key)
        if (key !== "waiting") return key
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return key
      }),
    )
    const cancelled = yield* run("waiting").pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const remaining = yield* run("waiting").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Fiber.interrupt(cancelled)
    expect(yield* run("other")).toBe("other")
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(remaining)).toBe("waiting")
    expect(calls).toEqual(["waiting", "other"])
  }),
)

it.effect("does not retain failed work", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const run = yield* SharedTask.make((key: string) =>
      Effect.sync(() => calls.push(key)).pipe(Effect.andThen(Effect.fail("failed"))),
    )
    expect(Exit.isFailure(yield* Effect.exit(run("retry")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(run("retry")))).toBe(true)
    expect(calls).toEqual(["retry", "retry"])
  }),
)

it.effect("stops shared work when its owner closes", () =>
  Effect.gen(function* () {
    const stopped = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const run = yield* SharedTask.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      )
      yield* run("scope").pipe(Effect.forkScoped)
      yield* Deferred.await(started)
    }).pipe(Effect.scoped)
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)
