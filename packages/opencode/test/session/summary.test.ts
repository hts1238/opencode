import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        SessionSummary.node,
        Session.node,
        Snapshot.node,
        SessionProjector.node,
        Database.node,
        CrossSpawnSpawner.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

it.instance(
  "summarizes only one turn in creation order and refreshes its latest snapshot",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const snapshot = yield* Snapshot.Service
      const instance = yield* TestInstance
      const session = yield* sessions.create({})
      const other = yield* sessions.create({})
      const user = {
        id: MessageID.make("msg_summary_user"),
        sessionID: session.id,
        role: "user",
        time: { created: 10 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User
      yield* sessions.updateMessage(user)
      yield* Effect.promise(() => Bun.write(`${instance.directory}/file.txt`, "before\n"))
      const before = yield* snapshot.track()
      yield* Effect.promise(() => Bun.write(`${instance.directory}/file.txt`, "after\n"))
      const after = yield* snapshot.track()
      expect(before).toBeTruthy()
      expect(after).toBeTruthy()

      const assistant = (id: string, created: number, parentID = user.id): SessionV1.Assistant => ({
        id: MessageID.make(id),
        sessionID: session.id,
        role: "assistant",
        parentID,
        agent: "build",
        mode: "build",
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        path: { cwd: instance.directory, root: instance.directory },
        time: { created },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const first = assistant("msg_z_first", 20)
      const last = assistant("msg_a_last", 30)
      const unrelated = assistant("msg_other_turn", 40, MessageID.make("msg_other_parent"))
      yield* Effect.forEach([first, last, unrelated], sessions.updateMessage)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: first.id,
        type: "step-start",
        snapshot: before,
      })
      const finish = {
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: last.id,
        type: "step-finish",
        snapshot: after,
        reason: "stop",
        cost: 0,
        tokens: last.tokens,
      } satisfies SessionV1.StepFinishPart
      yield* sessions.updatePart(finish)
      yield* sessions.updatePart({
        ...finish,
        id: PartID.ascending(),
        messageID: unrelated.id,
        snapshot: before,
      })
      // Large historical tool/text content must not be hydrated to read a diff.
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: unrelated.id,
        type: "text",
        text: "output".repeat(100_000),
      })

      yield* summary.summarize({ sessionID: session.id, messageID: user.id })
      const expected = yield* snapshot.diffFull(before!, after!)
      expect(expected.map((item) => item.file)).toEqual(["file.txt"])
      expect(yield* summary.diff({ sessionID: session.id, messageID: user.id })).toEqual(expected)
      expect(yield* summary.diff({ sessionID: other.id, messageID: user.id })).toEqual([])
      expect(yield* summary.diff({ sessionID: session.id, messageID: MessageID.make("msg_missing") })).toEqual([])

      yield* Effect.promise(() => Bun.write(`${instance.directory}/file.txt`, "after\ncontinued\n"))
      const continued = yield* snapshot.track()
      yield* sessions.updatePart({ ...finish, snapshot: continued })
      yield* summary.summarize({ sessionID: session.id, messageID: user.id })
      const latest = yield* summary.diff({ sessionID: session.id, messageID: user.id })
      expect(latest).toEqual(yield* snapshot.diffFull(before!, continued!))
      expect(latest).not.toEqual(expected)
      expect((yield* MessageV2.getInfo({ sessionID: session.id, messageID: user.id })).role).toBe("user")

      yield* sessions.remove(session.id)
      yield* sessions.remove(other.id)
    }),
  { git: true },
)
