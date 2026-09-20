import { Project, SyntaxKind, ts } from "ts-morph"
import type { Identifier } from "ts-morph"
import { describe, expect, it } from "vitest"
import { referencesWithin } from "../../../adapters/typescript/references.js"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { unitOf } from "../../../adapters/typescript/units.js"
import { escapesUnit } from "./escapes.js"
import { comparingHookArgumentOf, hookArgumentOf, hookArgumentSemantics } from "./hooks.js"
import { classifyUsage } from "./usages.js"

/** Parses a component body and returns every reference to `value`, plus its unit. */
function analyse(body: string, binding = "value"): { refs: Identifier[]; unit: FunctionLike } {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, strict: false },
  })
  const preamble = [
    'import * as React from "react"',
    'import { useMemo, useState, useRef, useReducer, useCallback, useEffect,',
    '  useLayoutEffect, useInsertionEffect, useImperativeHandle,',
    '  useSyncExternalStore, useDeferredValue } from "react"',
  ].join("\n")
  const source = project.createSourceFile("t.tsx", `${preamble}\n${body}\n`)
  const declaration = source
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((d) => d.getName() === binding)
  if (!declaration) throw new Error(`no binding named ${binding}`)
  const nameNode = declaration.getNameNode().asKindOrThrow(SyntaxKind.Identifier)
  const unit = unitOf(declaration)
  if (!unit) throw new Error("binding is not inside a function")
  return { refs: referencesWithin(nameNode, unit), unit }
}

function escapes(body: string): boolean {
  const { refs, unit } = analyse(body)
  return refs.some((ref) => escapesUnit(ref, unit))
}

describe("escapesUnit — what actually leaves the unit", () => {
  it("treats `||` and `??` as exits on either side", () => {
    expect(escapes("function useX(){ const value = useMemo(()=>1,[]); return value || fallback }")).toBe(true)
    expect(escapes("function useX(){ const value = useMemo(()=>1,[]); return fallback ?? value }")).toBe(true)
  })

  it("treats only the right side of `&&` as an exit", () => {
    // The everyday render guard: a truthiness test, not an exit.
    expect(
      escapes("function C(){ const value = useMemo(()=>1,[]); return value && <em>yes</em> }"),
    ).toBe(false)
    expect(escapes("function useX(){ const value = useMemo(()=>1,[]); return ready && value }")).toBe(true)
  })

  it("treats only the branches of a conditional as an exit", () => {
    expect(escapes("function useX(){ const value = useMemo(()=>1,[]); return on ? value : null }")).toBe(true)
    expect(
      escapes("function C(){ const value = useMemo(()=>1,[]); return value ? <A/> : <B/> }"),
    ).toBe(false)
  })

  it("still catches the plain and wrapped hook returns", () => {
    expect(escapes("function useX(){ const value = useMemo(()=>1,[]); return value }")).toBe(true)
    expect(escapes("function useX(){ const value = useMemo(()=>1,[]); return { value } }")).toBe(true)
    expect(escapes("function useX(){ const value = useMemo(()=>1,[]); ref.current = value; return 1 }")).toBe(true)
  })

  it("does not treat rendering the value as an exit", () => {
    expect(
      escapes("function C(){ const value = useMemo(()=>1,[]); return <div>{value}</div> }"),
    ).toBe(false)
  })
})

describe("hook arguments — described always, skipped selectively", () => {
  const passedTo = (hook: string) =>
    analyse(`function C(){ const value = useMemo(()=>1,[]); const x = ${hook}(value); return x }`)

  it("never skips on hooks that read the argument once and never compare it", () => {
    for (const hook of ["useState", "useRef", "useReducer"]) {
      const { refs } = passedTo(hook)
      expect(comparingHookArgumentOf(refs[0]!), hook).toBeNull()
      // ...but the model is still told the value reaches the hook.
      expect(hookArgumentOf(refs[0]!)).toBe(hook)
      expect(classifyUsage(refs[0]!).description).toContain(`passed to ${hook}(), which`)
    }
  })

  it("never skips on deps-driven hooks, whose dep array is the comparison surface", () => {
    for (const hook of ["useMemo", "useCallback", "useEffect", "useLayoutEffect", "useInsertionEffect"]) {
      const { refs } = passedTo(hook)
      expect(comparingHookArgumentOf(refs[0]!), hook).toBeNull()
    }
  })

  it("keeps useImperativeHandle as comparing: React concats the ref into its deps", () => {
    const { refs } = passedTo("useImperativeHandle")
    expect(comparingHookArgumentOf(refs[0]!)).toBe("useImperativeHandle")
    expect(classifyUsage(refs[0]!).description).toBe("`value` passed to the hook useImperativeHandle()")
  })

  it("asserts React semantics only about React's own exports", () => {
    // A local declaration sharing the name is not React's hook.
    const shadowed = analyse(
      "function C(){ const value = useMemo(()=>1,[]); const x = useLocalState(value); return x }\n" +
        "function useLocalState(v){ return v }",
    )
    expect(hookArgumentSemantics(shadowed.refs[0]!)).toBeNull()
    // Unknown => treated as comparing => skipped, the safe direction.
    expect(comparingHookArgumentOf(shadowed.refs[0]!)).toBe("useLocalState")
    expect(classifyUsage(shadowed.refs[0]!).description).toBe(
      "`value` passed to the hook useLocalState()",
    )
  })

  it("recognises a namespace-aliased React hook", () => {
    const project = "import * as Rt from \"react\"\n"
    const { refs } = analyse(
      `${project}function C(){ const value = useMemo(()=>1,[]); const x = Rt.useState(value); return x }`,
    )
    expect(comparingHookArgumentOf(refs[0]!)).toBeNull()
    expect(classifyUsage(refs[0]!).description).toContain("never compares it across renders")
  })

  it("states the deps-driven semantics for an effect or factory argument", () => {
    const { refs } = passedTo("useEffect")
    expect(classifyUsage(refs[0]!).description).toBe(
      "`value` passed to useEffect(), which compares only its dependency array, not this argument",
    )
  })

  it("skips on any other hook, including one we cannot see inside", () => {
    expect(comparingHookArgumentOf(passedTo("useQuery").refs[0]!)).toBe("useQuery")
    expect(comparingHookArgumentOf(passedTo("useDeferredValue").refs[0]!)).toBe("useDeferredValue")
    expect(comparingHookArgumentOf(passedTo("useSomeVendorThing").refs[0]!)).toBe("useSomeVendorThing")
  })

  it("resolves the React namespace form", () => {
    const { refs } = passedTo("React.useState")
    expect(comparingHookArgumentOf(refs[0]!)).toBeNull()
    expect(comparingHookArgumentOf(passedTo("React.useQuery").refs[0]!)).toBe("React.useQuery")
  })
})

describe("classifyUsage — truthiness guards read as consumers", () => {
  it("describes a `&&` guard without marking it unclassifiable", () => {
    const { refs } = analyse("function C(){ const value = useMemo(()=>1,[]); return value && <em/> }")
    const usage = classifyUsage(refs[0]!)
    expect(usage.resolved).toBe(true)
    expect(usage.description).toBe("`value` tested for truthiness in a `&&` expression")
  })

  it("describes an `if` condition", () => {
    const { refs } = analyse("function C(){ const value = useMemo(()=>1,[]); if (value) { go() } return null }")
    expect(classifyUsage(refs[0]!).description).toBe("`value` tested for truthiness in an `if`")
  })

  it("describes a hook argument even where we do not skip", () => {
    const { refs } = analyse("function C(){ const value = useMemo(()=>1,[]); const [s] = useState(value); return s }")
    const usage = classifyUsage(refs[0]!)
    expect(usage.kind).toBe("hook-argument")
    // The React semantics are a static fact; stating them stops the model
    // reading "reaches a hook" as "identity matters".
    expect(usage.description).toBe(
      "`value` passed to useState(), which reads it once on mount and never compares it across renders",
    )
  })
})
