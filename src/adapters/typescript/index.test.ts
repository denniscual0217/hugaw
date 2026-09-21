import { resolve } from "node:path"
import { Project, SyntaxKind, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { typescriptAdapter } from "./index.js"
import { importSourceOf } from "./imports.js"
import { referencesWithin } from "./references.js"
import { unitName, unitOf } from "./units.js"

const cwd = resolve(import.meta.dirname, "../../..")
// Fixtures are grouped per rule; this adapter test borrows one.
const fixture = (rel: string) => resolve(cwd, "fixtures", "pointless-usememo", rel)

function inMemory(source: string, name = "sample.tsx") {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, strict: false },
  })
  return project.createSourceFile(name, source)
}

describe("typescript adapter", () => {
  it("loads a .tsx fixture with no tsconfig and no @types/react", async () => {
    const file = fixture("should-warn/constant-object.tsx")
    const program = await typescriptAdapter.load({
      files: [file],
      cwd,
      options: typescriptAdapter.parseOptions({}),
    })
    try {
      // Dependencies are resolved but never linted.
      expect(program.files.map((f) => program.filePath(f))).toEqual([file])

      const source = program.files[0]!
      const call = source
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .find((c) => c.getExpression().getText() === "useMemo")!
      expect(call).toBeDefined()

      const unit = program.unitOf(call)!
      expect(unit).not.toBeNull()
      expect(program.unitName(unit)).toBe("Price")
      expect(program.unitKey(unit)).toBe(`${file}#${unit.getStart()}`)
      expect(program.nodeType(call)).toBe("CallExpression")

      const loc = program.locate(call)
      // 1-based, exactly like ESLint — the `useMemo(` on line 8.
      expect(loc.line).toBe(8)
      expect(loc.column).toBe(17)
      expect(loc.endLine).toBe(8)
    } finally {
      program.dispose()
    }
  })

  it("resolves react imports syntactically for named, namespace and default forms", () => {
    const source = inMemory(
      [
        'import { useMemo } from "react"',
        'import * as React from "react"',
        'import Rt from "react"',
        'import { useMemo as um } from "./local"',
        "export function C() {",
        "  useMemo(() => 1, [])",
        "  React.useMemo(() => 2, [])",
        "  Rt.useMemo(() => 3, [])",
        "  um(() => 4, [])",
        "  return null",
        "}",
      ].join("\n"),
    )
    const callees = source
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((c) => importSourceOf(c.getExpression()))

    expect(callees[0]).toEqual({ module: "react", name: "useMemo", viaNamespace: false })
    expect(callees[1]).toEqual({ module: "react", name: "useMemo", viaNamespace: true })
    expect(callees[2]).toEqual({ module: "react", name: "useMemo", viaNamespace: true })
    expect(callees[3]).toEqual({ module: "./local", name: "useMemo", viaNamespace: false })
  })

  it("counts references by symbol, so shadowed names are not usages", () => {
    const source = inMemory(
      [
        "export function C({ flag }) {",
        "  const label = 1",
        "  if (flag) {",
        "    const label = 2",
        "    use(label)",
        "  }",
        "  return label",
        "}",
      ].join("\n"),
    )
    const outer = source
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((d) => d.getName() === "label")!
    const fn = source.getFunctions()[0]!
    const refs = referencesWithin(outer.getNameNode().asKindOrThrow(SyntaxKind.Identifier), fn)

    // Only the `return label` on line 7 — the inner block has its own binding.
    expect(refs.map((r) => r.getStartLineNumber())).toEqual([7])
  })

  it("names arrow-function units after their variable declaration", () => {
    const source = inMemory("const Widget = () => null\n")
    const arrow = source.getDescendantsOfKind(SyntaxKind.ArrowFunction)[0]!
    expect(unitName(arrow)).toBe("Widget")
  })

  it("reports no unit for a node at module scope", () => {
    const source = inMemory("const x = compute()\n", "top.ts")
    const call = source.getDescendantsOfKind(SyntaxKind.CallExpression)[0]!
    expect(unitOf(call)).toBeNull()
  })

  it("rejects unknown option shapes", () => {
    expect(() => typescriptAdapter.parseOptions({ tsconfig: 42 })).toThrow(/Invalid typescript adapter options/)
  })
})
