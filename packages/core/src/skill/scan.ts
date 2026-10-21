export * as SkillScan from "./scan"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"

const ignoredDirectories = ["node_modules", ".git", ".venv", "venv", "__pycache__"]
export const ignore = ["**/.*", "**/.*/**", ...ignoredDirectories.flatMap((name) => [`**/${name}`, `**/${name}/**`])]

// A skill is a discovery boundary; its dependencies and supporting files are not additional skills.
export const scan = Effect.fn("SkillScan.scan")(function* (root: string, loose = true) {
  const fs = yield* FSUtil.Service
  const files: string[] = []
  const queue = [{ directory: root, depth: 0 }]
  for (const item of queue) {
    const entries = yield* fs.readDirectoryEntries(item.directory).pipe(Effect.orElseSucceed(() => []))
    const children = yield* Effect.forEach(
      entries.filter((entry) => !entry.name.startsWith(".") && !ignoredDirectories.includes(entry.name)),
      (entry) => {
        const target = path.join(item.directory, entry.name)
        if (entry.type !== "symlink") return Effect.succeed({ name: entry.name, path: target, type: entry.type })
        return fs.stat(target).pipe(
          Effect.map((info) => (info.type === "Directory" ? "directory" : info.type === "File" ? "file" : "other")),
          Effect.orElseSucceed(() => "other" as const),
          Effect.map((type) => ({ name: entry.name, path: target, type })),
        )
      },
      { concurrency: 8 },
    )
    const skill = children.find((child) => child.type === "file" && child.name === "SKILL.md")
    if (skill) {
      files.push(skill.path)
      continue
    }
    if (loose && item.depth === 0)
      files.push(
        ...children.filter((child) => child.type === "file" && child.name.endsWith(".md")).map((child) => child.path),
      )
    if (item.depth < 6)
      queue.push(
        ...children
          .filter((child) => child.type === "directory")
          .map((child) => ({ directory: child.path, depth: item.depth + 1 })),
      )
  }
  return files.toSorted()
})
