export * as SessionTitle from "./title"

import { LLM, LLMClient, LLMEvent, Message, type LLMError, type LLMRequest } from "@opencode-ai/llm"
import { and, eq, gte, inArray, lt } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { SessionV1 } from "../v1/session"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

const MAX_LENGTH = 100
const titleChanged = Symbol("Session title changed")

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly agents: AgentV2.Interface
  readonly models: SessionRunnerModel.Interface
  readonly store: SessionStore.Interface
}

export interface Interface {
  /** Generates a title from the first user message while the session still has its fallback title. */
  readonly generateForFirstPrompt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionTitle") {}

const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)
const isUntitled = (session: SessionSchema.Info) =>
  session.title === `New session - ${DateTime.formatIso(session.time.created)}`

const make = (dependencies: Dependencies) => {
  const generateForFirstPrompt = Effect.fn("SessionTitle.generateForFirstPrompt")(function* (
    db: Database.Interface["db"],
    sessionID: SessionSchema.ID,
  ) {
    const session = yield* dependencies.store.get(sessionID)
    if (!session || session.parentID || !isUntitled(session)) return
    const firstUser = yield* SessionHistory.firstUserMessage(db, session.id)
    if (!firstUser) return
    const agent = yield* dependencies.agents.get(AgentV2.ID.make("title"))
    if (!agent) return
    const model = yield* (agent.model
      ? dependencies.models.resolve({ ...session, model: agent.model })
      : dependencies.models.resolve(session)
    ).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!model) return
    const expectedSequence = (yield* EventV2.latestSequence(db, sessionID)) + 1
    const chunks: string[] = []
    let failed = false
    const streamed = yield* dependencies.llm
      .stream(
        LLM.request({
          model,
          system: agent.system,
          messages: [Message.user(firstUser.text)],
          tools: [],
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    if (!streamed || failed) return
    const title = chunks
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (!title) return
    const current = yield* dependencies.store.get(sessionID)
    if (!current || !isUntitled(current)) return
    yield* dependencies.events
      .publish(
        SessionEvent.Renamed,
        {
          sessionID,
          timestamp: yield* DateTime.now,
          title: truncate(title),
        },
        {
          commit: (sequence) => {
            if (sequence === expectedSequence) return Effect.void
            const renamedVersion = SessionEvent.Renamed.durable?.version
            const updatedVersion = SessionV1.Event.Updated.durable?.version
            if (renamedVersion === undefined || updatedVersion === undefined)
              return Effect.die("Session title events must be durable")
            return db
              .select({ id: EventTable.id })
              .from(EventTable)
              .where(
                and(
                  eq(EventTable.aggregate_id, sessionID),
                  gte(EventTable.seq, expectedSequence),
                  lt(EventTable.seq, sequence),
                  inArray(EventTable.type, [
                    EventV2.versionedType(SessionEvent.Renamed.type, renamedVersion),
                    EventV2.versionedType(SessionV1.Event.Updated.type, updatedVersion),
                  ]),
                ),
              )
              .get()
              .pipe(
                Effect.orDie,
                Effect.flatMap((event) => (event ? Effect.die(titleChanged) : Effect.void)),
              )
          },
        },
      )
      .pipe(Effect.catchDefect((defect) => (defect === titleChanged ? Effect.void : Effect.die(defect))))
  })
  return { generateForFirstPrompt }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const database = yield* Database.Service
    const title = make({ events, llm, agents, models, store })
    return Service.of({
      generateForFirstPrompt: (sessionID) => title.generateForFirstPrompt(database.db, sessionID),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, llmClient, AgentV2.node, SessionRunnerModel.node, SessionStore.node, Database.node],
})
