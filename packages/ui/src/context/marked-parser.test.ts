import { expect, test } from "bun:test"
import { createMarkdownParser } from "./marked-parser"

const parser = createMarkdownParser((code, language) => `<pre data-language="${language}">${code}</pre>`)

test("renders links with application attributes", async () => {
  expect(await parser.parse("[OpenCode](https://opencode.ai)")).toBe(
    '<p><a href="https://opencode.ai" class="external-link" target="_blank" rel="noopener noreferrer">OpenCode</a></p>\n',
  )
})

test("renders inline and block math", async () => {
  expect(await parser.parse("\\(x^2\\)")).toContain('<span class="katex">')
  expect(await parser.parse("$$\nx^2\n$$\n")).toContain('<span class="katex-display">')
})

test("uses the configured code highlighter", async () => {
  expect(await parser.parse("```ts\nconst value = 1\n```\n")).toBe('<pre data-language="ts">const value = 1</pre>\n')
})

test.each(["**", "__"])("separates standalone %s lead-ins from the following text", async (marker) => {
  expect(await parser.parse(`${marker}Heading with \`code\`${marker}\nBody with **emphasis**.`)).toBe(
    '<p class="markdown-heading"><strong>Heading with <code>code</code></strong></p>\n<p>Body with <strong>emphasis</strong>.</p>\n',
  )
})

test.each([
  ["**Inline** text.\nNext line.", "<p><strong>Inline</strong> text.\nNext line.</p>\n"],
  ["Plain text\nwith **emphasis**.", "<p>Plain text\nwith <strong>emphasis</strong>.</p>\n"],
  ["**Multiple\nlines**\nBody.", "<p><strong>Multiple\nlines</strong>\nBody.</p>\n"],
  ["**Standalone emphasis.**", "<p><strong>Standalone emphasis.</strong></p>\n"],
  ["`**Not a heading**`\nBody.", "<p><code>**Not a heading**</code>\nBody.</p>\n"],
  ["\\*\\*Not a heading\\*\\*\nBody.", "<p>**Not a heading**\nBody.</p>\n"],
  ["```text\n**Not a heading**\nBody.\n```", '<pre data-language="text">**Not a heading**\nBody.</pre>\n'],
])("preserves ordinary Markdown: %s", async (source, html) => {
  expect(await parser.parse(source)).toBe(html)
})
