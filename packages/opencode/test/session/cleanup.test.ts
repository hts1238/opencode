import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionCleanup } from "@/session/cleanup"
import { Session } from "@/session/session"
import { Clock, Duration, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionCleanup.node,
      Session.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const exists = (sessions: Session.Interface, id: Session.Info["id"]) =>
  sessions.get(id).pipe(Effect.exit, Effect.map(Exit.isSuccess))

describe("SessionCleanup", () => {
  it.live("removes only archived sessions older than 14 days", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const cleanup = yield* SessionCleanup.Service
      const database = yield* Database.Service
      const directory = yield* tmpdirScoped({ git: true })
      const now = yield* Clock.currentTimeMillis
      const records = yield* provideInstance(directory)(
        Effect.gen(function* () {
          const expired = yield* sessions.create({ title: "expired" })
          const recent = yield* sessions.create({ title: "recent" })
          const active = yield* sessions.create({ title: "active" })
          const touched = yield* sessions.create({ title: "touched" })
          yield* sessions.setArchived({
            sessionID: expired.id,
            time: now - Duration.toMillis(Duration.days(15)),
          })
          yield* sessions.setArchived({
            sessionID: recent.id,
            time: now - Duration.toMillis(Duration.days(13)),
          })
          yield* sessions.setArchived({
            sessionID: touched.id,
            time: now - Duration.toMillis(Duration.days(15)),
          })
          yield* database.db
            .update(SessionTable)
            .set({ time_updated: now - Duration.toMillis(Duration.days(15)) })
            .where(eq(SessionTable.id, expired.id))
            .run()
            .pipe(Effect.orDie)
          return { expired, recent, active, touched }
        }),
      )

      expect(yield* cleanup.run()).toBe(1)
      expect(yield* exists(sessions, records.expired.id)).toBe(false)
      expect(yield* exists(sessions, records.recent.id)).toBe(true)
      expect(yield* exists(sessions, records.active.id)).toBe(true)
      expect(yield* exists(sessions, records.touched.id)).toBe(true)

      const mode = (yield* database.db.values<[number]>("PRAGMA auto_vacuum"))[0]?.[0]
      expect(mode).toBe(2)
      yield* sessions.remove(records.recent.id)
      yield* sessions.remove(records.active.id)
      yield* sessions.remove(records.touched.id)
    }),
  )

  it.live("keeps an expired parent with an ineligible child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const cleanup = yield* SessionCleanup.Service
      const database = yield* Database.Service
      const directory = yield* tmpdirScoped({ git: true })
      const now = yield* Clock.currentTimeMillis
      const records = yield* provideInstance(directory)(
        Effect.gen(function* () {
          const parent = yield* sessions.create({ title: "expired parent" })
          const activeChild = yield* sessions.create({ title: "active child", parentID: parent.id })
          const expiredChild = yield* sessions.create({ title: "expired child", parentID: parent.id })
          yield* sessions.setArchived({
            sessionID: parent.id,
            time: now - Duration.toMillis(Duration.days(15)),
          })
          yield* sessions.setArchived({
            sessionID: expiredChild.id,
            time: now - Duration.toMillis(Duration.days(15)),
          })
          yield* Effect.forEach([parent.id, expiredChild.id], (sessionID) =>
            database.db
              .update(SessionTable)
              .set({ time_updated: now - Duration.toMillis(Duration.days(15)) })
              .where(eq(SessionTable.id, sessionID))
              .run()
              .pipe(Effect.orDie),
          )
          return { parent, activeChild, expiredChild }
        }),
      )

      expect(yield* cleanup.run()).toBe(1)
      expect(yield* exists(sessions, records.parent.id)).toBe(true)
      expect(yield* exists(sessions, records.activeChild.id)).toBe(true)
      expect(yield* exists(sessions, records.expiredChild.id)).toBe(false)
      yield* sessions.remove(records.parent.id)
    }),
  )

  it.live("removes orphaned event history from an interrupted deletion", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const cleanup = yield* SessionCleanup.Service
      const database = yield* Database.Service
      const directory = yield* tmpdirScoped({ git: true })
      const session = yield* provideInstance(directory)(sessions.create({ title: "orphaned events" }))

      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
      expect(
        yield* database.db
          .select({ id: EventSequenceTable.aggregate_id })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()

      expect(yield* cleanup.run()).toBe(0)
      expect(
        yield* database.db
          .select({ id: EventSequenceTable.aggregate_id })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.live("aborts retention deletion when a child appears after selection", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const database = yield* Database.Service
      const directory = yield* tmpdirScoped({ git: true })
      const now = yield* Clock.currentTimeMillis
      const parent = yield* provideInstance(directory)(sessions.create({ title: "racing parent" }))
      const cutoff = now - Duration.toMillis(Duration.days(14))
      yield* sessions.setArchived({ sessionID: parent.id, time: cutoff - 1 })
      yield* database.db
        .update(SessionTable)
        .set({ time_updated: cutoff - 1 })
        .where(eq(SessionTable.id, parent.id))
        .run()
        .pipe(Effect.orDie)
      const selected = yield* sessions.get(parent.id)
      const child = yield* provideInstance(directory)(sessions.create({ title: "new child", parentID: parent.id }))

      const deleted = yield* provideInstance(directory)(
        events.publish(
          Session.Event.Deleted,
          { sessionID: parent.id, info: selected },
          { metadata: { sessionCleanup: { archivedBefore: cutoff } } },
        ),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(deleted)).toBe(true)
      expect(yield* exists(sessions, parent.id)).toBe(true)
      expect(yield* exists(sessions, child.id)).toBe(true)
      yield* sessions.remove(parent.id)
    }),
  )
})
