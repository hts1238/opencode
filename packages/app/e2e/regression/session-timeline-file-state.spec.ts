import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  partUpdated,
  reasoningPart,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("updates edit diagnostics without resetting manual collapse state", async ({ page }) => {
  const editID = "prt_diagnostics_edit"
  const base = editPart(editID, [])
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([base])],
    settings: { editToolPartsExpanded: true },
  })
  const trigger = page.locator(`[data-timeline-part-id="${editID}"] [data-slot="collapsible-trigger"]`)
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.send(
    partUpdated(editPart(editID, [diagnostic("First failure", 2), diagnostic("Second failure", 4)])),
    300,
  )
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.send(partUpdated(editPart(editID, [])), 300)
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})

test("preserves nested patch file state through outer collapse and reopen", async ({ page }) => {
  const patchID = "prt_nested_patch"
  const files = [patchFile("src/a.ts", "update"), patchFile("src/b.ts", "add"), patchFile("src/old.ts", "delete")]
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          patchID,
          "apply_patch",
          "completed",
          { files: files.map((file) => file.filePath) },
          { metadata: { files } },
        ),
      ]),
    ],
    settings: { editToolPartsExpanded: true },
  })
  const wrapper = page.locator(`[data-timeline-part-id="${patchID}"]`)
  const outer = wrapper.locator(
    ':scope > [data-component="apply-patch-tool"] > [data-component="collapsible"] > [data-slot="collapsible-trigger"]',
  )
  const deleted = wrapper.locator('[data-scope="apply-patch"] [data-type="delete"]')
  await deleted.getByRole("button").click()
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")
  await outer.click()
  await expect(outer).toHaveAttribute("aria-expanded", "false")
  await outer.click()
  await expect(outer).toHaveAttribute("aria-expanded", "true")
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")
})

test("preserves nested patch state when a later text extends reasoning", async ({ page }) => {
  const patchID = "prt_02_streaming_patch"
  const files = [patchFile("src/a.ts", "update"), patchFile("src/old.ts", "delete")]
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        reasoningPart("prt_01_streaming_reasoning", "Inspecting files"),
        toolPart(
          patchID,
          "apply_patch",
          "completed",
          { files: files.map((file) => file.filePath) },
          { metadata: { files } },
        ),
        textPart("prt_03_streaming_progress", "Progress update"),
      ]),
    ],
    settings: { editToolPartsExpanded: true, showReasoningSummaries: true },
  })
  await page.getByRole("button", { name: "Show reasoning", exact: true }).click()
  const wrapper = page.locator(`[data-timeline-part-id="${patchID}"]`)
  const deleted = wrapper.locator('[data-scope="apply-patch"] [data-type="delete"]')
  await deleted.getByRole("button").click()
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")

  await timeline.send(partUpdated(textPart("prt_04_streaming_final", "Final response")), 300)

  await expect(page.getByText("Final response", { exact: true })).toBeVisible()
  await expect(
    page.locator('[data-slot="assistant-preamble-toggle"]:not([data-position="end"])'),
  ).toHaveAttribute("aria-expanded", "true")
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")
})

function patchFile(filePath: string, type: "add" | "update" | "delete") {
  return {
    filePath,
    relativePath: filePath,
    type,
    additions: type === "delete" ? 0 : 4,
    deletions: type === "add" ? 0 : 3,
    before: type === "add" ? undefined : source(false),
    after: type === "delete" ? undefined : source(true),
  }
}

function editPart(id: string, diagnostics: Record<string, unknown>[]) {
  return toolPart(
    id,
    "edit",
    "completed",
    { filePath: "src/edit.ts" },
    {
      metadata: {
        filediff: { file: "src/edit.ts", additions: 1, deletions: 1, before: source(false), after: source(true) },
        diagnostics,
      },
    },
  )
}

function diagnostic(message: string, line: number) {
  return { message, severity: 1, range: { start: { line, character: 0 }, end: { line, character: 2 } } }
}

function source(changed: boolean) {
  return Array.from({ length: 12 }, (_, index) => `export const value${index} = ${changed ? index + 1 : index}\n`).join(
    "",
  )
}
