import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { Project, SyntaxKind, ts } from "ts-morph"
import type { CallExpression, SourceFile } from "ts-morph"
import { describe, expect, it } from "vitest"
import { createProject } from "../../../adapters/typescript/project.js"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { unitOf } from "../../../adapters/typescript/units.js"
import { isReactApi } from "../analysis/react-imports.js"
import { calleeSourcesOf } from "./callee-sources.js"
import { componentStateOf } from "./component-state.js"
import { effectBodyOf } from "./effect-body.js"
import { effectCallOf } from "./effect-call.js"

const PREAMBLE =
  'import { useEffect, useState, useRef, useMemo, useCallback, useContext } from "react"'

function parse(body: string, extra: Record<string, string> = {}): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      strict: false,
      lib: ["lib.dom.d.ts", "lib.es2022.d.ts"],
    },
  })
  for (const [name, text] of Object.entries(extra)) project.createSourceFile(name, text)
  return project.createSourceFile("t.tsx", `${PREAMBLE}\n${body}\n`)
}

function effectOf(body: string, extra: Record<string, string> = {}): {
  call: CallExpression
  unit: FunctionLike
} {
  const file = parse(body, extra)
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((c) => isReactApi(c.getExpression(), "useEffect"))
  if (!call) throw new Error("no React useEffect in source")
  return { call, unit: unitOf(call)! }
}

/* ── component_state ─────────────────────────────────────────────────────── */

describe("component_state — the unit's own anatomy", () => {
  it("describes a component: props, state, and every write site", () => {
    const { unit } = effectOf(
      [
        "function Profile({ userId, onSaved }) {",
        "  const [comment, setComment] = useState('')",
        "  useEffect(() => { setComment('') }, [userId])",
        "  const handleType = (e) => setComment(e.target.value)",
        "  return null",
        "}",
      ].join("\n"),
    )
    const state = componentStateOf(unit)

    expect(state.owner).toEqual({ name: "Profile", kind: "component" })
    expect(state.props).toEqual(["userId", "onSaved"])
    expect(state.state).toHaveLength(1)
    const [declared] = state.state
    expect(declared?.value).toBe("comment")
    expect(declared?.setter).toBe("setComment")
    expect(declared?.initial).toBe("''")
    expect(declared?.writes.map((w) => w.within)).toEqual(["effect", "handler"])
  })

  it("describes a custom hook as a hook, with its arguments as props", () => {
    const { unit } = effectOf(
      "function useThing(onDone) { const [v] = useState(0); useEffect(() => { onDone(v) }, [v]) }",
    )
    const state = componentStateOf(unit)
    expect(state.owner).toEqual({ name: "useThing", kind: "hook" })
    expect(state.props).toEqual(["onDone"])
  })

  it("carries hook results with the hook that produced them", () => {
    const { unit } = effectOf(
      [
        'import { useGetProductQuery } from "./_gen"',
        "function Child({ onFetched }) {",
        "  const { data } = useGetProductQuery()",
        "  useEffect(() => { if (data) onFetched(data) }, [data, onFetched])",
        "}",
      ].join("\n"),
      { "_gen.ts": "export function useGetProductQuery(){ return { data: null } }" },
    )
    expect(componentStateOf(unit).hookResults).toEqual([
      { binding: "data", hook: "useGetProductQuery", from: "./_gen" },
    ])
  })
})

/* ── effect_call ─────────────────────────────────────────────────────────── */

describe("effect_call — the anatomy of the call itself", () => {
  it("carries deps, cleanup and an inline callback", () => {
    const { call, unit } = effectOf(
      "function Chat({ roomId }) { useEffect(() => { const c = connect(roomId); return () => c.close() }, [roomId]) }",
    )
    const slice = effectCallOf(call, unit)
    expect(slice.depsKind).toBe("list")
    expect(slice.deps).toEqual(["roomId"])
    expect(slice.hasCleanup).toBe(true)
    expect(slice.callback).toBe("inline")
    expect(slice.readsOutsideDeps).toEqual([])
    expect(slice.source).toContain("useEffect(")
    expect(slice.line).toBe(2)
  })

  it("names a callback it could not follow, which is what the caveat is built from", () => {
    const { call, unit } = effectOf(
      'import { syncTitle } from "./nowhere"\nfunction C(){ useEffect(syncTitle, []) }',
    )
    expect(effectCallOf(call, unit).callback).toEqual({ name: "syncTitle", resolved: false })
  })

  it("reports a read outside the deps as a fact of the empty-deps shape", () => {
    const { call, unit } = effectOf(
      "function Chat({ roomId }) { useEffect(() => { const c = connect(roomId); return () => c.close() }, []) }",
    )
    const slice = effectCallOf(call, unit)
    expect(slice.depsKind).toBe("empty")
    expect(slice.readsOutsideDeps).toEqual(["roomId"])
  })
})

/* ── effect_body ─────────────────────────────────────────────────────────── */

describe("effect_body — calls, callee bodies, externals", () => {
  it("separates a snapshot-mirroring listener from the state it writes", () => {
    const { call, unit } = effectOf(
      [
        "function useOnline() {",
        "  const [isOnline, setIsOnline] = useState(navigator.onLine)",
        "  useEffect(() => {",
        "    const update = () => setIsOnline(navigator.onLine)",
        "    window.addEventListener('online', update)",
        "    return () => window.removeEventListener('online', update)",
        "  }, [])",
        "}",
      ].join("\n"),
    )
    const body = effectBodyOf(call, unit)

    expect(body.externals).toEqual([
      "navigator.onLine",
      "window.addEventListener",
      "window.removeEventListener",
    ])
    const setter = body.calls.find((c) => c.kind === "state-setter")
    expect(setter?.callee).toBe("setIsOnline")
    // The setter is not in the effect body: it is in the listener. That is the
    // whole difference between mirroring a snapshot and accumulating events.
    expect(setter?.nested).toBe("inside the local function `update`")
  })

  it("inlines a same-file callee and names a cross-file one", () => {
    const { call, unit } = effectOf(
      [
        'import { fetchProduct } from "./_api"',
        "function Page({ id }) {",
        "  const [p, setP] = useState(null)",
        "  useEffect(() => { fetchProduct(id).then(setP) }, [id])",
        "}",
      ].join("\n"),
      { "_api.ts": "export function fetchProduct(id){ return Promise.resolve(id) }" },
    )
    const body = effectBodyOf(call, unit)
    expect(body.unresolved).toEqual(["fetchProduct"])
    expect(body.calls.map((c) => [c.callee, c.kind])).toEqual([
      ["fetchProduct(id).then", "member"],
      ["fetchProduct", "imported"],
    ])
  })

  it("is empty, not broken, when the callback cannot be reached", () => {
    const { call, unit } = effectOf(
      'import { syncTitle } from "./nowhere"\nfunction C(){ useEffect(syncTitle, []) }',
    )
    expect(effectBodyOf(call, unit)).toEqual({
      calls: [],
      resolved: {},
      unresolved: [],
      externals: [],
    })
  })
})

/* ── the ambient-declaration change, against the rule that already ships ─── */

describe("callee_sources — the ambient rule must not move the memo rule", () => {
  /**
   * `calleeSourcesOf` is shared, and `unresolved` drives `MemoFacts.
   * unresolvedCallees` and the caveat clause built from it. Passing over
   * ambient declarations can only ever *remove* names from that list, so the
   * regression to guard is a memo fixture that silently stops caveating.
   *
   * Every memo whose factory calls *anything* by name is listed, including
   * the ones that resolve to nothing at all. Listing only the memos with a
   * non-empty result would leave the ambient branch untested by a real
   * fixture: `ambient-callee.tsx` is the entry that is supposed to be empty,
   * and an entry that is supposed to be empty has to be written down, or the
   * day it stops being empty nothing notices.
   */
  const EXPECTED: Record<string, { resolved: string[]; unresolved: string[] }> = {
    // `parseInt` is ambient: seen, classified, and deliberately neither
    // inlined nor called a blind spot.
    "ambient-callee.tsx:9": { resolved: [], unresolved: [] },
    "constant-object.tsx:8": { resolved: ["format"], unresolved: [] },
    "cross-file-callee.tsx:5": { resolved: [], unresolved: ["slugify"] },
    "prop-callee.tsx:7": { resolved: [], unresolved: ["transform"] },
  }

  it("leaves every memo fixture's resolved/unresolved sets exactly as they were", () => {
    const root = resolve(import.meta.dirname, "../../../../fixtures/pointless-usememo")
    const files = ["should-warn", "should-pass", "not-a-candidate"].flatMap((bucket) =>
      readdirSync(resolve(root, bucket)).map((name) => resolve(root, bucket, name)),
    )
    const project = createProject({ cwd: resolve(root, "../.."), files })

    const actual: Record<string, { resolved: string[]; unresolved: string[] }> = {}
    for (const file of project.getSourceFiles()) {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!isReactApi(call.getExpression(), "useMemo")) continue
        // "Its factory names at least one callee" — the population the slice
        // has an opinion about, empty opinions included.
        const named = (call.getArguments()[0]?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? [])
          .some((inner) => inner.getExpression().getKind() === SyntaxKind.Identifier)
        if (!named) continue
        const sources = calleeSourcesOf(call)
        actual[`${file.getBaseName()}:${call.getStartLineNumber()}`] = {
          resolved: Object.keys(sources.resolved),
          unresolved: sources.unresolved,
        }
      }
    }
    expect(actual).toEqual(EXPECTED)
  })

  it("passes over an ambient declaration instead of calling it a blind spot", () => {
    const file = parse("function C(){ const v = useMemo(() => parseInt(raw, 10), [raw]) }")
    const call = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => isReactApi(c.getExpression(), "useMemo"))!
    expect(calleeSourcesOf(call)).toEqual({ resolved: {}, unresolved: [] })
  })
})
