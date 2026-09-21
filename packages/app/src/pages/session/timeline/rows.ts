import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { AssistantMessage, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { groupParts, renderable, type PartGroup } from "@opencode-ai/session-ui/message-part"
import { TimelineRow, type SummaryDiff } from "./timeline-row"
import { uniqueSummaryDiffs } from "./summary-diffs"

export { TimelineRow, type SummaryDiff } from "./timeline-row"

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
    id?: string
    summary?: string
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }
  AssistantPreamble: {
    userMessageID: string
    groups: PartGroup[]
    previousAssistantPart: boolean
  }
  AssistantToolGroup: {
    userMessageID: string
    groups: PartGroup[]
    previousAssistantPart: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string }
}

export namespace Timeline {
  export function constructSessionMessageRows(
    messages: SessionMessageInfo[],
    getMessage: (messageID: string) => UserMessage | AssistantMessage | undefined,
    getMessageParts: (messageID: string) => Part[],
    showReasoning: boolean,
    status: SessionStatus["type"],
    inlineComments: boolean,
    projectedUserMessages: UserMessage[],
  ) {
    type Compaction = Extract<SessionMessageInfo, { type: "compaction" }>
    const turns: {
      user: UserMessage
      assistants: AssistantMessage[]
      compactions: { message: Compaction; afterAssistant: number }[]
    }[] = []
    const turnByUserID = new Map<string, (typeof turns)[number]>()
    let currentTurn: (typeof turns)[number] | undefined
    messages.forEach((message) => {
      const projected = getMessage(message.id)
      if (message.type === "shell" && projected?.role === "user") {
        const assistant = getMessage(`${message.id}:assistant`)
        const turn = {
          user: projected,
          assistants: assistant?.role === "assistant" ? [assistant] : [],
          compactions: [],
        }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        currentTurn = undefined
        return
      }
      if (projected?.role === "user") {
        const existing = turnByUserID.get(projected.id)
        if (existing) {
          currentTurn = existing
          return
        }
        const turn = { user: projected, assistants: [], compactions: [] }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        currentTurn = turn
        return
      }
      if (projected?.role !== "assistant") {
        if (message.type === "compaction")
          currentTurn?.compactions.push({ message, afterAssistant: currentTurn.assistants.length })
        return
      }
      const existing = turnByUserID.get(projected.parentID)
      if (existing) {
        existing.assistants.push(projected)
        currentTurn = existing
        return
      }
      const user = getMessage(projected.parentID)
      if (user?.role !== "user") return
      const turn = { user, assistants: [projected], compactions: [] }
      turns.push(turn)
      turnByUserID.set(user.id, turn)
      currentTurn = turn
    })
    const latestUserMessageID = turns.at(-1)?.user.id
    projectedUserMessages.forEach((user) => {
      if (turnByUserID.has(user.id)) return
      if (latestUserMessageID && user.id < latestUserMessageID) return
      const turn = { user, assistants: [], compactions: [] }
      turns.push(turn)
      turnByUserID.set(user.id, turn)
    })
    const activeMessageID = turns.at(-1)?.user.id
    return {
      activeMessageID,
      rows: turns.flatMap((turn, index) =>
        constructMessageRows(
          turn.user,
          getMessageParts,
          turn.assistants,
          turn.compactions,
          index,
          showReasoning,
          status,
          turn.user.id === activeMessageID,
          inlineComments,
        ),
      ),
    }
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    currentCompactions: {
      message: Extract<SessionMessageInfo, { type: "compaction" }>
      afterAssistant: number
    }[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    // v2 renders comments inside the user message attachments row instead of a strip row
    inlineComments: boolean,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compactionParts = userParts.filter((part) => part.type === "compaction")
    const summaryMessages = assistantMessages.filter((message) => message.summary)
    const compactions = currentCompactions.length
      ? currentCompactions.flatMap(({ message, afterAssistant }) =>
          "status" in message && message.status === "failed"
            ? []
            : [
                {
                  id: message.id,
                  summary: "summary" in message && typeof message.summary === "string" ? message.summary : "",
                  afterAssistant: assistantMessages.slice(0, afterAssistant).filter((item) => !item.summary).length,
                },
              ],
        )
      : [
          ...summaryMessages.map((message, summaryIndex) => {
            const messageIndex = assistantMessages.indexOf(message)
            return {
              id: compactionParts[summaryIndex]?.id ?? message.id,
              summary: getMessageParts(message.id)
                .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text] : []))
                .join("\n\n"),
              afterAssistant: assistantMessages.slice(0, messageIndex).filter((item) => !item.summary).length,
            }
          }),
          ...compactionParts.slice(summaryMessages.length).map((part) => ({
            id: part.id,
            summary: "",
            afterAssistant: 0,
          })),
        ]
    const contentMessages = assistantMessages.filter((message) => !message.summary)
    const interruptedMessageIndex = contentMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const latestError = assistantMessages.at(-1)?.error
    const error = latestError?.name === "MessageAbortedError" ? undefined : latestError

    const assistantPartRefs = contentMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderable(part, true))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const assistantCompaction = assistantPartRefs.some((ref) => ref.part.type === "compaction")
    const assistantItems = orderedAssistantItems(
      assistantPartRefs,
      compactions,
      interrupted && compactions.length === 0 && !assistantCompaction ? interruptedMessageIndex + 1 : undefined,
    )
    if (previousUserMessage) rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0 && !inlineComments)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: inlineComments || comments.length === 0,
      }),
    )

    const finalTextIndex = finalAssistantTextIndex(assistantItems, assistantPartRefs)
    let assistantGroupIndex = 0
    assistantSections(assistantItems, assistantPartRefs, finalTextIndex, showReasoning).forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      if (item.type === "preamble") {
        rows.push(
          new TimelineRow.AssistantPreamble({
            userMessageID: userMessage.id,
            groups: item.groups,
            previousAssistantPart: assistantGroupIndex > 0,
          }),
        )
        assistantGroupIndex += 1
        return
      }

      if (item.type === "compaction") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "compaction",
            id: item.id,
            summary: item.summary,
          }),
        )
        return
      }

      if (item.type === "tools") {
        rows.push(
          new TimelineRow.AssistantToolGroup({
            userMessageID: userMessage.id,
            groups: item.groups,
            previousAssistantPart: assistantGroupIndex > 0,
          }),
        )
        assistantGroupIndex += 1
        return
      }

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
        }),
      )
      assistantGroupIndex += 1
    })

    if (isActive && status === "busy" && !error && (showReasoning ? assistantPartRefs.length === 0 : true)) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
        }),
      )
    }

    if (isActive && status === "retry") rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        new TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
        }),
      )
    }

    if (error) {
      const data = error.data?.message
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
        }),
      )
    }

    return rows
  }

  function finalAssistantTextIndex(
    items: Array<
      | { type: "part"; group: PartGroup }
      | { type: "interrupted" }
      | { type: "compaction"; id: string; summary: string }
    >,
    refs: Array<{ messageID: string; part: Part }>,
  ) {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]
      if (!item || item.type !== "part") continue
      if (assistantGroupTextPart(item.group, refs)) return index
    }
    return -1
  }

  function orderedAssistantItems(
    refs: Array<{ messageID: string; messageIndex: number; part: Part }>,
    compactions: { id: string; summary: string; afterAssistant: number }[],
    interruption?: number,
  ) {
    const markers = [
      ...compactions.map((compaction) => ({
        afterAssistant: compaction.afterAssistant,
        item: { type: "compaction" as const, id: compaction.id, summary: compaction.summary },
      })),
      ...(interruption === undefined
        ? []
        : [{ afterAssistant: interruption, item: { type: "interrupted" as const } }]),
    ].sort((a, b) => a.afterAssistant - b.afterAssistant)
    const result: Array<
      | { type: "part"; group: PartGroup }
      | { type: "interrupted" }
      | { type: "compaction"; id: string; summary: string }
    > = []
    let start = 0

    markers.forEach((marker) => {
      result.push(
        ...groupParts(refs.filter((ref) => ref.messageIndex >= start && ref.messageIndex < marker.afterAssistant)).map(
          (group) => ({ type: "part" as const, group }),
        ),
        marker.item,
      )
      start = marker.afterAssistant
    })
    result.push(
      ...groupParts(refs.filter((ref) => ref.messageIndex >= start)).map((group) => ({ type: "part" as const, group })),
    )
    return result
  }

  function assistantSections(
    items: Array<
      | { type: "part"; group: PartGroup }
      | { type: "interrupted" }
      | { type: "compaction"; id: string; summary: string }
    >,
    refs: Array<{ messageID: string; part: Part }>,
    finalTextIndex: number,
    showReasoning: boolean,
  ) {
    type Section =
      | { type: "part"; group: PartGroup }
      | { type: "interrupted" }
      | { type: "preamble"; groups: PartGroup[] }
      | { type: "tools"; groups: PartGroup[] }
      | { type: "compaction"; id: string; summary: string }
    const result: Section[] = []
    const collapsePreamble =
      finalTextIndex > 0 && !items.slice(0, finalTextIndex).some((item) => item.type === "interrupted")
    let preamble: Extract<Section, { type: "preamble" }> | undefined
    let tools: Extract<Section, { type: "tools" }> | undefined

    const pushBoundary = (item: Extract<Section, { type: "part" | "interrupted" | "compaction" }>) => {
      result.push(item)
      preamble = undefined
      tools = undefined
    }

    items.forEach((item, index) => {
      if (item.type === "interrupted") {
        pushBoundary(item)
        return
      }
      if (item.type === "compaction") {
        pushBoundary(item)
        return
      }

      const part = assistantGroupPart(item.group, refs)
      if (part?.type === "compaction") {
        pushBoundary({ type: "compaction", id: part.id, summary: "" })
        return
      }
      if (part?.type === "reasoning" && !showReasoning) return

      const type = isLowLevelToolGroup(item.group, refs)
        ? "tools"
        : collapsePreamble && index < finalTextIndex && part?.type !== "tool"
          ? "preamble"
          : "part"
      if (type === "part") {
        pushBoundary(item)
        return
      }
      if (type === "preamble") {
        if (preamble) {
          preamble.groups.push(item.group)
          return
        }
        const section: Extract<Section, { type: "preamble" }> = { type, groups: [item.group] }
        result.push(section)
        preamble = section
        return
      }
      if (tools) {
        tools.groups.push(item.group)
        return
      }
      const section: Extract<Section, { type: "tools" }> = { type, groups: [item.group] }
      result.push(section)
      tools = section
    })

    return result
  }

  function isLowLevelToolGroup(group: PartGroup, refs: Array<{ messageID: string; part: Part }>) {
    const part = assistantGroupPart(group, refs)
    return part?.type === "tool" && part.tool !== "task" && part.tool !== "question"
  }

  function assistantGroupPart(group: PartGroup, refs: Array<{ messageID: string; part: Part }>) {
    const ref = group.type === "part" ? group.ref : group.refs[0]
    if (!ref) return
    return refs.find((item) => item.messageID === ref.messageID && item.part.id === ref.partID)?.part
  }

  function assistantGroupTextPart(group: PartGroup, refs: Array<{ messageID: string; part: Part }>) {
    return assistantGroupPart(group, refs)?.type === "text"
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}
