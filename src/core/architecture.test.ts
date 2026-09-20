import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * SPEC §1: hugaw is not a React linter. The core must contain zero React
 * knowledge and zero TypeScript-specific knowledge. This is the mechanical
 * guard — reviewers should treat any hit here as a defect.
 */
const CORE_DIR = fileURLToPath(new URL(".", import.meta.url))

const FORBIDDEN = [
  "ts-morph",
  "typescript",
  "react",
  "@typesafe-ai/sdk",
  // The self-alias would otherwise be a back door: `import { typescriptAdapter }
  // from "hugaw"` reaches the whole tree from inside core.
  "hugaw",
  "../adapters/",
  "../plugins/",
  "../judge/",
  "../cli/",
  "../format/",
]

/** Recursive: a future `src/core/sub/` must not escape the guard. */
function coreFiles(): string[] {
  return readdirSync(CORE_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(CORE_DIR, f))
    .sort()
}

function isForbidden(specifier: string): boolean {
  return FORBIDDEN.some((bad) =>
    bad.endsWith("/")
      ? specifier.startsWith(bad)
      : specifier === bad || specifier.startsWith(`${bad}/`),
  )
}

/** Comments may name the forbidden worlds (that is what they are for); code may not. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

/** Matches the module specifier of any static import/export or dynamic import. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const staticRe = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g
  const bareRe = /(?:^|\n)\s*import\s*["']([^"']+)["']/g
  const dynamicRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g
  for (const re of [staticRe, bareRe, dynamicRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) if (m[1]) specifiers.push(m[1])
  }
  return specifiers
}

describe("core architecture", () => {
  const files = coreFiles()

  it("finds core source files to check", () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files.filter((f) => !f.endsWith(".test.ts")))("%s imports nothing language-specific", (file) => {
    const source = readFileSync(file, "utf8")
    const offenders = importSpecifiers(source).filter(isForbidden)
    expect(offenders, `${file} must not import ${offenders.join(", ")}`).toEqual([])
  })

  it("mentions no React or ts-morph identifiers", () => {
    const banned = /\b(useMemo|SourceFile|SyntaxKind|ts-morph|TypeSafeClient|JsxElement)\b/
    for (const file of files) {
      if (file.endsWith("architecture.test.ts")) continue
      const source = stripComments(readFileSync(file, "utf8"))
      expect(banned.test(source), `${file} mentions a language-specific identifier`).toBe(false)
    }
  })
})
