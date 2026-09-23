import { Project, SyntaxKind, ts } from "ts-morph"
import type { CallExpression } from "ts-morph"
import { describe, expect, it } from "vitest"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { unitOf } from "../../../adapters/typescript/units.js"
import { isReactApi } from "./react-imports.js"
import { indirectCallsOf } from "./indirect.js"

const PREAMBLE = 'import { useEffect, useState, useRef } from "react"'

function indirect(body: string, extra: Record<string, string> = {}) {
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
  const file = project.createSourceFile("t.tsx", `${PREAMBLE}\n${body}\n`)
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((c: CallExpression) => isReactApi(c.getExpression(), "useEffect"))!
  return indirectCallsOf(call, unitOf(call) as FunctionLike)
}

describe("one level through a same-file helper", () => {
  it("finds state the helper sets", () => {
    expect(
      indirect(`function C() {
  const [count] = useState(0)
  const [finished, setFinished] = useState(false)
  function evaluateCount(value) { if (value >= 10) setFinished(true) }
  useEffect(() => { evaluateCount(count) }, [count])
}`),
    ).toEqual([
      { callee: "evaluateCount", states: ["finished"], propCallbacks: [], outwardCalls: [], externals: [] },
    ])
  })

  it("counts a setter the helper hands to something else", () => {
    // `.then(setUser)` never calls the setter in that body, but the state is
    // written all the same — the direct path already counts this shape.
    const [entry] = indirect(`function C({ userId }) {
  const [user, setUser] = useState(null)
  function loadUser(id) { fetch("/u/" + id).then((r) => r.json()).then(setUser) }
  useEffect(() => { loadUser(userId) }, [userId])
}`)
    expect(entry?.states).toEqual(["user"])
  })

  it("does not report a call chain once per link", () => {
    // `fetch(u).then(p).then(s)` is three CallExpressions whose leftmost
    // identifier is the same ambient `fetch`, so all three classify `global`.
    const [entry] = indirect(`function C({ id }) {
  function load(x) { fetch("/u/" + x).then((r) => r.json()) }
  useEffect(() => { load(id) }, [id])
}`)
    expect(entry?.outwardCalls).toEqual(['fetch("/u/" + x)'])
  })

  it("finds a callback prop the helper calls", () => {
    const [entry] = indirect(`function C({ onChange }) {
  const [isOn] = useState(false)
  function notifyParent(value) { onChange(value) }
  useEffect(() => { notifyParent(isOn) }, [isOn, onChange])
}`)
    expect(entry?.propCallbacks).toEqual(["onChange"])
  })

  it("finds externals the helper touches", () => {
    const [entry] = indirect(`function C() {
  function subscribe(update) { window.addEventListener("online", update) }
  useEffect(() => { subscribe(() => {}) }, [])
}`)
    expect(entry?.externals).toEqual(["window.addEventListener"])
  })

  it("finds a ref handle the helper writes", () => {
    const [entry] = indirect(`function C() {
  const hostRef = useRef(null)
  function mountEditor() { hostRef.current.focus() }
  useEffect(() => { mountEditor() }, [])
}`)
    expect(entry?.externals).toEqual(["hostRef.current"])
  })

  it("says nothing about a helper that does none of these", () => {
    expect(
      indirect(`function C({ label }) {
  function describe(value) { return value.trim().toUpperCase() }
  useEffect(() => { describe(label) }, [label])
}`),
    ).toEqual([])
  })

  it("says nothing about a callee it could not read", () => {
    // The guardrail: a cross-file body was never inlined into the payload and
    // is never described in the message.
    expect(
      indirect(
        `import { fetchProduct } from "./_api"
function C({ id }) {
  const [p, setP] = useState(null)
  useEffect(() => { fetchProduct(id).then(setP) }, [id])
}`,
        { "_api.ts": "export function fetchProduct(id) { return fetch('/p/' + id) }" },
      ),
    ).toEqual([])
  })

  it("stops at one level, and says nothing rather than guessing", () => {
    // `outer` calls `inner`, and `inner` is where the state is set. One body
    // is inlined into the payload, so one body is how far the evidence goes:
    // `outer` has nothing nameable of its own, so it earns no clause at all
    // and `statesWritten` stays empty. The fix then says "delete the effect"
    // rather than "delete the state and the effect", which is the correct
    // direction to be wrong in.
    expect(
      indirect(`function C() {
  const [done, setDone] = useState(false)
  function inner() { setDone(true) }
  function outer() { inner() }
  useEffect(() => { outer() }, [])
}`),
    ).toEqual([])
  })

  it("does not walk the effect's own callback as its helper", () => {
    expect(
      indirect(`function C() {
  const [done, setDone] = useState(false)
  function syncTitle() { setDone(true) }
  useEffect(syncTitle, [])
}`),
    ).toEqual([])
  })
})
