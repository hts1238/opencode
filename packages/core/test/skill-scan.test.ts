import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SkillScan } from "@opencode-ai/core/skill/scan"
import { tmpdir } from "./fixture/tmpdir"

test("skill discovery bounds traversal while preserving linked skills and loose root markdown", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "skills")
  const names = [
    "valid",
    "valid/nested",
    "node_modules/hidden",
    ".hidden/skill",
    ".venv/skill",
    "a/b/c/d/e/f",
    "a/b/c/d/e/f/g",
  ]
  await Promise.all(
    names.map(async (name) => {
      await fs.mkdir(path.join(root, name), { recursive: true })
      await fs.writeFile(path.join(root, name, "SKILL.md"), "# Skill")
    }),
  )
  await fs.writeFile(path.join(root, "command.md"), "# Command")
  await fs.mkdir(path.join(tmp.path, "external"))
  await fs.writeFile(path.join(tmp.path, "external", "SKILL.md"), "# Linked skill")
  await fs.symlink(path.join(tmp.path, "external"), path.join(root, "linked"), "dir")
  await fs.mkdir(path.join(root, "cycle"))
  await fs.symlink(path.join(root, "cycle"), path.join(root, "cycle", "again"), "dir")

  const layer = AppNodeBuilder.build(FSUtil.node)
  const files = await Effect.runPromise(SkillScan.scan(root).pipe(Effect.provide(layer)))
  expect(files.map((file) => path.relative(root, file))).toEqual([
    "a/b/c/d/e/f/SKILL.md",
    "command.md",
    "linked/SKILL.md",
    "valid/SKILL.md",
  ])
  expect(await Effect.runPromise(SkillScan.scan(root, false).pipe(Effect.provide(layer)))).not.toContain(
    path.join(root, "command.md"),
  )
})

test("shared skill discovery joins scans and observes later filesystem changes", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "command.md"), "# Command")
  await Effect.runPromise(
    Effect.gen(function* () {
      const scanner = yield* SkillScan.Service
      const files = yield* Effect.all([scanner.scan(tmp.path), scanner.scan(tmp.path)], { concurrency: "unbounded" })
      expect(files[0]).toBe(files[1])
      expect(files[0]).toEqual([path.join(tmp.path, "command.md")])
      expect(yield* scanner.scan(tmp.path, false)).toEqual([])
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "added")))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "added", "SKILL.md"), "# New skill"))
      expect(yield* scanner.scan(tmp.path)).toContain(path.join(tmp.path, "added", "SKILL.md"))
    }).pipe(Effect.scoped, Effect.provide(AppNodeBuilder.build(SkillScan.node))),
  )
})
