import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMError, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
const model = Model.make({
  id: "title-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})
const successfulTitle = () => Stream.make(LLMEvent.textDelta({ id: "title", text: "Generated Title\n" }))
let titleStream: () => Stream.Stream<LLMEvent, LLMError> = successfulTitle
const client = Layer.mock(LLMClient.Service, {
  stream: (request) => {
    requests.push(request)
    return titleStream()
  },
})
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      SessionTitle.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [SessionRunnerModel.node, models],
    ],
  ),
)

const insertSession = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const created = Date.parse("2026-07-30T18:45:03.662Z")
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: `New session - ${new Date(created).toISOString()}`,
        version: "test",
        time_created: created,
        time_updated: created,
      })
      .run()
      .pipe(Effect.orDie)
  })

const prompt = (sessionID: SessionV2.ID, text: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Prompted, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.makeUnsafe(0),
      prompt: Prompt.make({ text }),
      delivery: "steer",
    })
  })

const enableTitleAgent = AgentV2.Service.pipe(
  Effect.flatMap((agents) =>
    agents.transform((draft) => {
      draft.update(AgentV2.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "Generate a title."
      })
    }),
  ),
)

it.effect("generates a title from the first user message", () =>
  Effect.gen(function* () {
    requests.length = 0
    titleStream = successfulTitle
    yield* enableTitleAgent
    const sessionID = SessionV2.ID.make("ses_title_generate")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const title = yield* SessionTitle.Service
    yield* title.generateForFirstPrompt(sessionID)

    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain("Help me debug the failing build")
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("retries generation from the first prompt after a failed title request", () =>
  Effect.gen(function* () {
    requests.length = 0
    yield* enableTitleAgent
    const sessionID = SessionV2.ID.make("ses_title_retry")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "First prompt")
    yield* prompt(sessionID, "Second prompt")
    const title = yield* SessionTitle.Service
    titleStream = () => Stream.make(LLMEvent.providerError({ message: "Provider unavailable" }))

    yield* title.generateForFirstPrompt(sessionID)
    titleStream = successfulTitle
    yield* title.generateForFirstPrompt(sessionID)

    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1]?.messages)).toContain("First prompt")
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("preserves a manual rename completed while generation is in flight", () =>
  Effect.gen(function* () {
    requests.length = 0
    yield* enableTitleAgent
    const sessionID = SessionV2.ID.make("ses_title_manual_rename")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Generate this title")
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    titleStream = () =>
      Stream.unwrap(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(successfulTitle()),
        ),
      )
    const title = yield* SessionTitle.Service
    const fiber = yield* title.generateForFirstPrompt(sessionID).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Renamed, {
      sessionID,
      timestamp: yield* DateTime.now,
      title: "Manual title",
    })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)

    expect(requests).toHaveLength(1)
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Manual title")
  }),
)

it.effect("allows unrelated Session events while generation is in flight", () =>
  Effect.gen(function* () {
    requests.length = 0
    yield* enableTitleAgent
    const sessionID = SessionV2.ID.make("ses_title_unrelated_event")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Generate this title")
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    titleStream = () =>
      Stream.unwrap(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(successfulTitle()),
        ),
      )
    const title = yield* SessionTitle.Service
    const fiber = yield* title.generateForFirstPrompt(sessionID).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: yield* DateTime.now,
      agent: "plan",
    })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)

    expect(requests).toHaveLength(1)
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)
