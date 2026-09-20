import { readFile } from "node:fs/promises"
import { defineAdapter, definePlugin, defineRule } from "../../src/core/define.js"
import { noul, score } from "../../src/core/questions.js"
import type { LanguageTypes, Program, Selection } from "../../src/core/types.js"

/**
 * A text-line language, used to prove `src/core` works with no ts-morph and no
 * React anywhere in the graph. Units are blank-line-separated paragraphs;
 * nodes are lines.
 */
export interface TextFile {
  readonly path: string
  readonly lines: readonly string[]
}
export interface TextUnit {
  readonly file: TextFile
  readonly start: number
  readonly end: number
}
export interface TextNode {
  readonly file: TextFile
  readonly line: number
  readonly text: string
}
export interface TextTypes extends LanguageTypes {
  readonly file: TextFile
  readonly node: TextNode
  readonly unit: TextUnit
}

function unitsOf(file: TextFile): TextUnit[] {
  const units: TextUnit[] = []
  let start: number | null = null
  file.lines.forEach((line, i) => {
    const blank = line.trim() === ""
    if (!blank && start === null) start = i
    if (blank && start !== null) {
      units.push({ file, start, end: i - 1 })
      start = null
    }
  })
  if (start !== null) units.push({ file, start, end: file.lines.length - 1 })
  return units
}

class TextProgram implements Program<TextTypes> {
  readonly files: readonly TextFile[]
  readonly #units = new Map<string, TextUnit[]>()

  constructor(files: readonly TextFile[]) {
    this.files = files
    for (const file of files) this.#units.set(file.path, unitsOf(file))
  }

  filePath(file: TextFile): string {
    return file.path
  }
  fileOf(node: TextNode): TextFile {
    return node.file
  }
  unitOf(node: TextNode): TextUnit | null {
    const units = this.#units.get(node.file.path) ?? []
    return units.find((u) => node.line >= u.start && node.line <= u.end) ?? null
  }
  unitKey(unit: TextUnit): string {
    return `${unit.file.path}#${unit.start}`
  }
  unitName(unit: TextUnit): string {
    return (unit.file.lines[unit.start] ?? "").trim()
  }
  locate(node: TextNode) {
    return {
      line: node.line + 1,
      column: 1,
      endLine: node.line + 1,
      endColumn: node.text.length + 1,
    }
  }
  nodeType(): string {
    return "Line"
  }
  textOf(node: TextNode): string {
    return node.text
  }
  dispose(): void {
    /* nothing to release */
  }
}

export const fakeTextAdapter = defineAdapter<TextTypes, Record<string, never>>({
  id: "text",
  extensions: [".txt"],
  parseOptions() {
    return {}
  },
  async load({ files }) {
    const loaded: TextFile[] = []
    for (const path of files) {
      const source = await readFile(path, "utf8")
      loaded.push({ path, lines: source.split("\n") })
    }
    return new TextProgram(loaded)
  },
})

/** Invocation counters so tests can prove a unit slice is built at most once. */
export const sliceCalls = { unit_text: 0, line_text: 0 }
export function resetSliceCalls(): void {
  sliceCalls.unit_text = 0
  sliceCalls.line_text = 0
}

function* linesContaining(file: TextFile, needle: string): Iterable<Selection<TextTypes, { text: string }>> {
  for (const [line, text] of file.lines.entries()) {
    if (text.includes(needle)) {
      yield { node: { file, line, text }, data: { text } }
    }
  }
}

const todoQuestions = {
  important: noul("Is this TODO important?", { true: "it blocks a release", false: "it is a nicety" }),
}
const fixmeQuestions = {
  urgency: score("How urgent is this FIXME?", ["can wait", "urgent"]),
}

export const todoRule = defineRule<
  TextTypes,
  { text: string },
  typeof todoQuestions,
  { text: string }
>({
  name: "todo",
  meta: { description: "flags important TODOs", defaultSeverity: "warn" },
  context: ["unit_text", "line_text"],
  select(file) {
    return linesContaining(file, "TODO")
  },
  skip(candidate) {
    return candidate.data.text.includes("(ok)") ? "explicitly marked ok" : null
  },
  ask() {
    return todoQuestions
  },
  decide(answers, { candidate }) {
    if (answers.important.noul <= 0.5) return null
    return {
      messageId: "importantTodo",
      message: `important TODO: ${candidate.data.text.trim()}`,
      facts: { text: candidate.data.text.trim() },
    }
  },
})

export const fixmeRule = defineRule<
  TextTypes,
  { text: string },
  typeof fixmeQuestions,
  { urgency: number }
>({
  name: "fixme",
  meta: { description: "flags urgent FIXMEs", defaultSeverity: "error" },
  context: ["unit_text"],
  select(file) {
    return linesContaining(file, "FIXME")
  },
  skip() {
    return null
  },
  ask() {
    return fixmeQuestions
  },
  decide(answers) {
    if (answers.urgency.score < 1) return null
    return {
      messageId: "urgentFixme",
      message: `urgent FIXME (${answers.urgency.score})`,
      facts: { urgency: answers.urgency.score },
    }
  },
})

export const fakeTextPlugin = definePlugin<TextTypes>({
  id: "fake",
  language: "text",
  rules: [todoRule, fixmeRule],
  slices: {
    unit_text: {
      scope: "unit",
      extract({ unit }) {
        sliceCalls.unit_text++
        return unit.file.lines.slice(unit.start, unit.end + 1).join("\n")
      },
    },
    line_text: {
      scope: "candidate",
      extract({ candidate }) {
        sliceCalls.line_text++
        return (candidate as { data: { text: string } }).data.text
      },
    },
  },
})
