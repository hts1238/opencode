import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

test("keeps legacy profiles and persists explicit switches in both directions", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory: "/layout-preference",
    project: {
      id: "project_layout",
      worktree: "/layout-preference",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    if (localStorage.getItem("settings.v3")) return
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await page.goto("/")
  await page.getByRole("button", { name: /^(Open settings|Settings)$/ }).click()
  const toggle = page.locator('[data-action="settings-new-layout-designs"] input')
  await expect(toggle).not.toBeChecked()
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.locator('[data-action="settings-new-layout-designs"]').click(),
  ])
  await page.getByRole("button", { name: /^(Open settings|Settings)$/ }).click()
  await expect(toggle).toBeChecked()
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.locator('[data-action="settings-new-layout-designs"]').click(),
  ])
  await page.getByRole("button", { name: /^(Open settings|Settings)$/ }).click()
  await expect(toggle).not.toBeChecked()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3")!).general.layoutDesign)).toBe(
    "legacy",
  )
})
