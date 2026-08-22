import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { NotFoundError } from "@/storage/storage"
import { and, sql } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Schedule } from "effect"
import { Session } from "./session"

const RETENTION = Duration.days(14)
const INTERVAL = Duration.days(1)

type Row = Pick<typeof SessionTable.$inferSelect, "id" | "parent_id" | "time_archived" | "time_updated">

export interface Interface {
  readonly run: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCleanup") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const flock = yield* EffectFlock.Service

    const removeExpired = () =>
      flock
        .withLock(
          Effect.gen(function* () {
            const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(RETENTION)
            const rows = yield* database.db
              .select({
                id: SessionTable.id,
                parent_id: SessionTable.parent_id,
                time_archived: SessionTable.time_archived,
                time_updated: SessionTable.time_updated,
              })
              .from(SessionTable)
              .all()
              .pipe(Effect.orDie)
            const removed = yield* Effect.forEach(retentionOrder(rows, cutoff), (sessionID) =>
              sessions.remove(sessionID, { archivedBefore: cutoff }).pipe(
                Effect.andThen(
                  sessions.get(sessionID).pipe(
                    Effect.as(false),
                    Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(true)),
                  ),
                ),
                Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(false)),
                Effect.catchCause(() => Effect.succeed(false)),
              ),
            )
            const orphaned = yield* database.db
              .all<{ id: Row["id"] }>(sql`
                SELECT session.id
                FROM session
                WHERE (
                  session.parent_id IS NULL
                  AND session.title GLOB '* (@* subagent)'
                  AND EXISTS (
                    SELECT 1
                    FROM json_each(session.permission)
                    WHERE json_extract(json_each.value, '$.permission') = 'task'
                      AND json_extract(json_each.value, '$.action') = 'deny'
                  )
                ) OR EXISTS (
                  SELECT 1
                  FROM event AS created
                  WHERE created.aggregate_id = session.id
                    AND created.type = 'session.created.1'
                    AND json_extract(created.data, '$.info.parentID') IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1
                      FROM session AS parent
                      WHERE parent.id = json_extract(created.data, '$.info.parentID')
                    )
                )
              `)
              .pipe(Effect.orDie)
            const removedOrphans = yield* Effect.forEach(orphaned, (row) =>
              sessions.remove(row.id).pipe(
                Effect.as(true),
                Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(false)),
                Effect.catchCause(() => Effect.succeed(false)),
              ),
            )
            const count = [...removed, ...removedOrphans].filter(Boolean).length
            yield* database.db
              .delete(EventSequenceTable)
              .where(
                and(
                  sql`${EventSequenceTable.aggregate_id} GLOB 'ses_*'`,
                  sql`NOT EXISTS (SELECT 1 FROM session WHERE session.id = ${EventSequenceTable.aggregate_id})`,
                ),
              )
              .run()
              .pipe(Effect.orDie)
            return count
          }),
          `session-cleanup:${Database.path()}`,
        )
        .pipe(Effect.orDie)

    const run = Effect.fn("SessionCleanup.run")(() =>
      Effect.gen(function* () {
        const count = yield* removeExpired()
        yield* reclaim(database.db).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session cleanup could not reclaim database space", { cause: Cause.pretty(cause) }),
          ),
        )
        if (count > 0) yield* Effect.logInfo("removed expired archived sessions", { count })
        return count
      }),
    )

    return Service.of({ run })
  }),
)

const scheduled = Layer.effectDiscard(
  Effect.gen(function* () {
    const cleanup = yield* Service
    yield* cleanup.run().pipe(
      Effect.catchCause((cause) => Effect.logError("session cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(INTERVAL)),
      Effect.forkScoped,
    )
  }),
)

function retentionOrder(rows: Row[], cutoff: number) {
  const eligible = new Set(
    rows
      .filter((row) => row.time_archived !== null && row.time_archived < cutoff && row.time_updated < cutoff)
      .map((row) => row.id),
  )
  const children = rows.reduce((result, row) => {
    if (!row.parent_id || !eligible.has(row.id) || !eligible.has(row.parent_id)) return result
    result.set(row.parent_id, [...(result.get(row.parent_id) ?? []), row.id])
    return result
  }, new Map<Row["id"], Row["id"][]>())

  const visited = new Set<Row["id"]>()
  const postorder = (id: Row["id"]): Row["id"][] => {
    if (visited.has(id)) return []
    visited.add(id)
    return [...(children.get(id) ?? []).flatMap(postorder), id]
  }
  return rows
    .filter((row) => eligible.has(row.id) && (!row.parent_id || !eligible.has(row.parent_id)))
    .flatMap((row) => postorder(row.id))
}

function reclaim(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const freelist = (yield* db.values<[number]>("PRAGMA freelist_count"))[0]?.[0] ?? 0
    if (freelist > 0) {
      const mode = (yield* db.values<[number]>("PRAGMA auto_vacuum"))[0]?.[0] ?? 0
      if (mode === 0) {
        yield* db.run("PRAGMA auto_vacuum = INCREMENTAL")
        yield* db.run("VACUUM")
      }
      if (mode === 2) yield* db.run("PRAGMA incremental_vacuum")
    }
    yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  })
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.merge(layer, scheduled.pipe(Layer.provide(layer))),
  deps: [Database.node, EffectFlock.node, Session.node, SessionProjector.node],
})

export * as SessionCleanup from "./cleanup"
