import { expect, test } from "@playwright/test"
import {
  defineVisualRegions,
  reportVisualStability,
  startVisualProbe,
  stopVisualProbe,
  visualPlan,
} from "../../utils/visual-stability"
import {
  assistantID,
  assistantMessage,
  event,
  partUpdated,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
  waitForVisualSettle,
} from "./fixture"

const inputs = {
  read: { filePath: "src/a.ts", offset: 0, limit: 120 },
  glob: { path: ".", pattern: "**/*.ts" },
  grep: { path: ".", pattern: "stable", include: "*.ts" },
  list: { path: "src" },
}

test("appends context operations while the group is expanded", async ({ page }, testInfo) => {
  const firstID = "prt_append_01_read"
  const followingID = "prt_append_99_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(firstID, "read", "running", inputs.read),
          toolPart("prt_append_02_glob", "glob", "running", inputs.glob),
          textPart(followingID, "Following append"),
        ],
        { completed: false },
      ),
    ],
    cpuRate: 4,
  })
  const initialIDs = `${firstID},prt_append_02_glob`
  const initialGroup = `.tool-collapsible[data-timeline-part-ids="${initialIDs}"]`
  await page.locator('[data-slot="assistant-preamble-toggle"]:not([data-position="end"])').click()
  await page
    .locator(`[data-component="assistant-tool-group"][data-timeline-part-ids="${initialIDs}"]`)
    .locator('[data-slot="assistant-tool-group-toggle"][data-position="start"]')
    .click()
  await page.locator(`${initialGroup} [data-slot="collapsible-trigger"]`).click()
  await waitForVisualSettle(page, [initialGroup, `[data-timeline-part-id="${followingID}"]`])
  const regions = defineVisualRegions({
    context: {
      selector: '.tool-collapsible[data-timeline-part-ids^="prt_append_01_read"]',
      closest: '[data-timeline-row="AssistantPreamble"]',
    },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(partUpdated(toolPart("prt_append_03_grep", "grep", "completed", inputs.grep)), 240)
  await timeline.send(partUpdated(toolPart("prt_append_04_list", "list", "completed", inputs.list)), 500)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "context-append",
    trace,
    visualPlan(
      regions,
      [
        { type: "required", regions: ["context", "following"] },
        { type: "unique", regions: ["context", "following"] },
        { type: "stable", regions: ["context", "following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: ["following"], maxPositionReversals: 0 },
        { type: "label-stability", regions: "all" },
        { type: "preserve-bottom-anchor" },
        { type: "flow", regions: ["context", "following"] },
      ],
      { perMarker: true },
    ),
  )
  await expect(
    page.locator(
      '.tool-collapsible[data-timeline-part-ids="prt_append_01_read,prt_append_02_glob,prt_append_03_grep,prt_append_04_list"]',
    ),
  ).toBeVisible()
  await expect(
    page.locator('.tool-collapsible[data-timeline-part-ids^="prt_append_01_read"] [data-slot="collapsible-trigger"]'),
  ).toHaveAttribute("aria-expanded", "true")
})

test("splits and merges context groups when a middle text part changes", async ({ page }, testInfo) => {
  const textID = "prt_split_02_text"
  const followingID = "prt_split_99_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart("prt_split_01_read", "read", "completed", inputs.read),
        textPart(textID, "Boundary"),
        toolPart("prt_split_03_glob", "glob", "completed", inputs.glob),
        textPart(followingID, "Following split groups"),
      ]),
    ],
    cpuRate: 4,
  })
  await page.locator('[data-slot="assistant-preamble-toggle"]:not([data-position="end"])').click()
  const regions = defineVisualRegions({
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    event("message.part.removed", { sessionID: "ses_timeline_stability", messageID: assistantID, partID: textID }),
    500,
  )
  await page
    .locator(
      '[data-component="assistant-tool-group"][data-timeline-part-ids="prt_split_01_read,prt_split_03_glob"]',
    )
    .locator('[data-slot="assistant-tool-group-toggle"][data-position="start"]')
    .click()
  await expect(
    page.locator('.tool-collapsible[data-timeline-part-ids="prt_split_01_read,prt_split_03_glob"]'),
  ).toBeVisible()
  await timeline.send(partUpdated(textPart(textID, "Boundary restored")), 500)
  await expect(page.locator('.tool-collapsible[data-timeline-part-ids="prt_split_01_read"]')).toBeVisible()
  await expect(page.locator('.tool-collapsible[data-timeline-part-ids="prt_split_03_glob"]')).toBeVisible()
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "context-split-merge",
    trace,
    visualPlan(
      regions,
      [
        { type: "required", regions: ["following"] },
        { type: "unique", regions: ["following"] },
        { type: "stable", regions: ["following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all", maxPositionReversals: 1 },
        { type: "label-stability", regions: "all" },
      ],
      { perMarker: true },
    ),
  )
})

test("removing the first context member replaces the group once without overlapping following content", async ({
  page,
}, testInfo) => {
  const ids = ["prt_key_01_read", "prt_key_02_glob", "prt_key_03_grep"]
  const followingID = "prt_key_99_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(ids[0]!, "read", "completed", inputs.read),
        toolPart(ids[1]!, "glob", "completed", inputs.glob),
        toolPart(ids[2]!, "grep", "completed", inputs.grep),
        textPart(followingID, "Following replaced group"),
      ]),
    ],
    cpuRate: 4,
  })
  await page.locator('[data-slot="assistant-preamble-toggle"]:not([data-position="end"])').click()
  await page
    .locator(`[data-component="assistant-tool-group"][data-timeline-part-ids="${ids.join(",")}"]`)
    .locator('[data-slot="assistant-tool-group-toggle"][data-position="start"]')
    .click()
  const original = page.locator(`.tool-collapsible[data-timeline-part-ids="${ids.join(",")}"]`)
  const originalRowKey = await original.evaluate((element) =>
    element.closest("[data-timeline-key]")?.getAttribute("data-timeline-key"),
  )
  await original.locator('[data-slot="collapsible-trigger"]').click()
  await expect(original.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
  const regions = defineVisualRegions({
    context: {
      selector: '.tool-collapsible[data-timeline-part-ids*="prt_key_02_glob"]',
      closest: '[data-timeline-row="AssistantPreamble"]',
    },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    event("message.part.removed", { sessionID: "ses_timeline_stability", messageID: assistantID, partID: ids[0] }),
    500,
  )
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "context-first-remove",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["context", "following"] },
      { type: "unique", regions: ["context", "following"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all", maxPositionReversals: 0 },
      { type: "label-stability", regions: "all" },
      { type: "flow", regions: ["context", "following"] },
    ]),
  )
  const updated = page.locator(`.tool-collapsible[data-timeline-part-ids="${ids.slice(1).join(",")}"]`)
  await expect(updated).toBeVisible()
  expect(
    await updated.evaluate((element) => element.closest("[data-timeline-key]")?.getAttribute("data-timeline-key")),
  ).toBe(originalRowKey)
  await expect(updated.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
})
