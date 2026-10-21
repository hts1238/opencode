export * as SharedTask from "./shared-task"

import { Effect, Fiber, Scope } from "effect"

// Share work, rather than a caller's wait, so cancelling one request cannot cancel the others.
export const make = <Key, A, E>(run: (key: Key) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const tasks = new Map<Key, Effect.Effect<A, E>>()
    return (key: Key) =>
      Effect.gen(function* () {
        const existing = tasks.get(key)
        if (existing) return yield* existing
        const start = yield* Effect.cached(
          run(key).pipe(Effect.ensuring(Effect.sync(() => tasks.delete(key))), Effect.forkIn(scope)),
        )
        const task = start.pipe(Effect.flatMap(Fiber.join))
        tasks.set(key, task)
        return yield* task
      })
  })
