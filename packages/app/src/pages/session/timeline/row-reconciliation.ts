import { TimelineRow } from "./timeline-row"
import type { PartGroup } from "@opencode-ai/session-ui/message-part"

type ContextGroup = Extract<PartGroup, { type: "context" }>
type PriorContext = { index: number; userMessageID: string; group: ContextGroup }

export function reuseTimelineRows(previous: TimelineRow.TimelineRow[] | undefined, rows: TimelineRow.TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = new Map(previous.map((row) => [TimelineRow.key(row), row] as const))
  const groupByKey = new Map<string, PartGroup>()
  const contextByPart = new Map<string, PriorContext>()
  const previousContextKeys = new Set<string>()
  let contextIndex = 0
  previous.forEach((row) => {
    partGroups(row).forEach((group) => groupByKey.set(contextKey(row.userMessageID, group.key), group))
    contextGroups(row).forEach((group) => {
      const prior = { index: contextIndex, userMessageID: row.userMessageID, group }
      previousContextKeys.add(contextKey(row.userMessageID, group.key))
      group.refs.forEach((ref) => contextByPart.set(`${row.userMessageID}:${ref.partID}`, prior))
      contextIndex += 1
    })
  })
  const reserved = new Map<string, string>()
  rows.forEach((row, index) => {
    contextGroups(row).forEach((group, groupIndex) => {
      const key = contextKey(row.userMessageID, group.key)
      if (previousContextKeys.has(key) && !reserved.has(key)) reserved.set(key, `${index}:${groupIndex}`)
    })
  })
  const claimed = new Set<string>()
  const next = rows.map((input, index) => {
    const row = reusePartGroups(groupByKey, stabilizeContextKeys(contextByPart, reserved, input, index, claimed))
    const existing = byKey.get(TimelineRow.key(row))
    if (!existing) return row
    return TimelineRow.equals(existing, row) ? existing : row
  })
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) return previous
  return next
}

function reusePartGroups(groupByKey: Map<string, PartGroup>, row: TimelineRow.TimelineRow) {
  const reuse = (group: PartGroup) => {
    const previous = groupByKey.get(contextKey(row.userMessageID, group.key))
    return previous && sameGroup(previous, group) ? previous : group
  }
  if (row._tag === "AssistantToolGroup") {
    const groups = row.groups.map(reuse)
    if (groups.every((group, index) => group === row.groups[index])) return row
    return new TimelineRow.AssistantToolGroup({ ...row, groups })
  }
  if (row._tag !== "AssistantPreamble") return row
  const items = row.items.map((item) => {
    if (item.type !== "part") return item
    const group = reuse(item.group)
    return group === item.group ? item : { ...item, group }
  })
  if (items.every((item, index) => item === row.items[index])) return row
  return new TimelineRow.AssistantPreamble({ ...row, items })
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a.type !== b.type || a.key !== b.key) return false
  if (a.type === "part" && b.type === "part")
    return a.ref.messageID === b.ref.messageID && a.ref.partID === b.ref.partID
  if (a.type !== "context" || b.type !== "context" || a.refs.length !== b.refs.length) return false
  return a.refs.every(
    (ref, index) => ref.messageID === b.refs[index]?.messageID && ref.partID === b.refs[index]?.partID,
  )
}

function stabilizeContextKeys(
  contextByPart: Map<string, PriorContext>,
  reserved: Map<string, string>,
  row: TimelineRow.TimelineRow,
  rowIndex: number,
  claimed: Set<string>,
) {
  if (row._tag === "AssistantPart" && row.group.type === "context") {
    const group = stabilizeContextGroup(contextByPart, reserved, row.userMessageID, row.group, `${rowIndex}:0`, claimed)
    if (group === row.group) return row
    return new TimelineRow.AssistantPart({ ...row, group })
  }
  if (row._tag === "AssistantToolGroup") {
    const groups = stabilizeContextList(contextByPart, reserved, row.userMessageID, row.groups, rowIndex, claimed)
    if (groups.every((group, index) => group === row.groups[index])) return row
    return new TimelineRow.AssistantToolGroup({ ...row, groups })
  }
  if (row._tag !== "AssistantPreamble") return row
  const groups = stabilizeContextList(contextByPart, reserved, row.userMessageID, partGroups(row), rowIndex, claimed)
  let groupIndex = 0
  const items = row.items.map((item) =>
    item.type === "part" ? { ...item, group: groups[groupIndex++] ?? item.group } : item,
  )
  if (
    items.every((item, index) => {
      const previous = row.items[index]
      return item.type !== "part" || (previous?.type === "part" && item.group === previous.group)
    })
  )
    return row
  return new TimelineRow.AssistantPreamble({ ...row, items })
}

function stabilizeContextList(
  contextByPart: Map<string, PriorContext>,
  reserved: Map<string, string>,
  userMessageID: string,
  groups: PartGroup[],
  rowIndex: number,
  claimed: Set<string>,
) {
  let contextIndex = 0
  return groups.map((group) => {
    if (group.type !== "context") return group
    const result = stabilizeContextGroup(
      contextByPart,
      reserved,
      userMessageID,
      group,
      `${rowIndex}:${contextIndex}`,
      claimed,
    )
    contextIndex += 1
    return result
  })
}

function stabilizeContextGroup(
  contextByPart: Map<string, PriorContext>,
  reserved: Map<string, string>,
  userMessageID: string,
  group: ContextGroup,
  ownerID: string,
  claimed: Set<string>,
) {
  const existing = group.refs.reduce<PriorContext | undefined>((result, ref) => {
    const candidate = contextByPart.get(`${userMessageID}:${ref.partID}`)
    if (!candidate) return result
    const key = contextKey(candidate.userMessageID, candidate.group.key)
    if (claimed.has(key)) return result
    const owner = reserved.get(key)
    if (owner !== undefined && owner !== ownerID) return result
    return !result || candidate.index < result.index ? candidate : result
  }, undefined)
  if (!existing) return group
  const key = contextKey(existing.userMessageID, existing.group.key)
  claimed.add(key)
  if (group.key === existing.group.key) return group
  return { ...group, key: existing.group.key }
}

function contextGroups(row: TimelineRow.TimelineRow) {
  return partGroups(row).filter((group): group is ContextGroup => group.type === "context")
}

function partGroups(row: TimelineRow.TimelineRow) {
  if (row._tag === "AssistantPart") return [row.group]
  if (row._tag === "AssistantToolGroup") return row.groups
  if (row._tag === "AssistantPreamble") return row.items.flatMap((item) => (item.type === "part" ? [item.group] : []))
  return []
}

function contextKey(userMessageID: string, groupKey: string) {
  return `${userMessageID}:${groupKey}`
}
