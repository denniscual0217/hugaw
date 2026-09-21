import { Project, SyntaxKind, ts } from "ts-morph"
import type { CallExpression, Identifier, SourceFile } from "ts-morph"
import { describe, expect, it } from "vitest"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { unitOf } from "../../../adapters/typescript/units.js"
import { bodyCalls, classifyCall, hookResultsOf } from "./body-calls.js"
import type { BodyCall } from "./body-calls.js"
import {
  dependencyRoots,
  depsKindOf,
  effectCallbackOf,
  externalReferences,
  hasCleanup,
  isReactEffectCallback,
  nestedContextOf,
  readsOutsideDeps,
} from "./effects.js"
import { stateSetters, writeContextOf, writeSitesOf } from "./state-setters.js"

const PREAMBLE = [
  'import { useEffect, useState, useReducer, useRef, useMemo, useCallback, useContext } from "react"',
].join("\n")

function project(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      strict: false,
      lib: ["lib.dom.d.ts", "lib.es2022.d.ts"],
    },
  })
}

/** Parses one component body; extra files are written beside it for imports. */
function parse(body: string, extra: Record<string, string> = {}): SourceFile {
  const p = project()
  for (const [name, text] of Object.entries(extra)) p.createSourceFile(name, text)
  return p.createSourceFile("t.tsx", `${PREAMBLE}\n${body}\n`)
}

interface Effect {
  readonly call: CallExpression
  readonly unit: FunctionLike
  readonly callback: FunctionLike
  readonly setters: Identifier[]
}

/** The nth `useEffect` in the source, with everything its analysis needs. */
function effect(body: string, extra: Record<string, string> = {}, index = 0): Effect {
  const file = parse(body, extra)
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getExpression().getText() === "useEffect")[index]
  if (!call) throw new Error("no useEffect in source")
  const unit = unitOf(call)
  if (!unit) throw new Error("useEffect is not inside a function")
  const { callback } = effectCallbackOf(call)
  const setters = stateSetters(unit)
    .map((s) => s.setter)
    .filter((s): s is Identifier => s !== null)
  return { call, unit, callback: callback as FunctionLike, setters }
}

/* ── effects.ts ──────────────────────────────────────────────────────────── */

describe("effectCallbackOf — following one level of indirection", () => {
  it("takes an inline arrow as the callback itself", () => {
    const { call } = effect("function C(){ useEffect(() => { go() }, []) }")
    const found = effectCallbackOf(call)
    expect(found.callbackName).toBe(null)
    expect(found.resolved).toBe(true)
    expect(found.callback).not.toBe(null)
  })

  it("resolves a same-file named callback and reports its name", () => {
    const { call } = effect(
      "function syncTitle(){ document.title = 'x' }\nfunction C(){ useEffect(syncTitle, []) }",
    )
    const found = effectCallbackOf(call)
    expect(found.callbackName).toBe("syncTitle")
    expect(found.resolved).toBe(true)
    expect(found.callback?.getText()).toContain("document.title")
  })

  it("names an unresolvable callback instead of pretending there is no body", () => {
    const { call } = effect('import { syncTitle } from "./nowhere"\nfunction C(){ useEffect(syncTitle, []) }')
    const found = effectCallbackOf(call)
    expect(found.callbackName).toBe("syncTitle")
    expect(found.resolved).toBe(false)
    expect(found.callback).toBe(null)
  })
})

describe("depsKindOf — the four shapes", () => {
  const cases: [string, string, string[] | null][] = [
    ["function C(){ useEffect(() => {}) }", "none", null],
    ["function C(){ useEffect(() => {}, []) }", "empty", []],
    ["function C(){ useEffect(() => {}, [a, b.c]) }", "list", ["a", "b.c"]],
    ["function C(){ useEffect(() => {}, deps) }", "unknown", null],
  ]
  it.each(cases)("%s -> %s", (source, kind, deps) => {
    const { call } = effect(source)
    expect(depsKindOf(call)).toEqual({ kind, deps })
  })
})

describe("hasCleanup — the three return shapes, and async", () => {
  const yes = [
    "function C(){ useEffect(() => { const c = open(); return () => c.close() }, []) }",
    "function C(){ useEffect(() => { const stop = sub(); return stop }, []) }",
    "function C(){ useEffect(() => () => teardown(), []) }",
  ]
  it.each(yes)("finds the cleanup in %s", (source) => {
    const { callback } = effect(source)
    expect(hasCleanup(callback)).toBe(true)
  })

  it("does not count a return from a nested callback", () => {
    const { callback } = effect(
      "function C(){ useEffect(() => { items.forEach(i => { return () => i }) }, []) }",
    )
    expect(hasCleanup(callback)).toBe(false)
  })

  it("reports no cleanup for an async callback, which is the truth", () => {
    // React ignores the promise an async effect returns, so there is no
    // teardown here however the body is written. The plan leaves what that
    // implies to the model; this only has to stop claiming otherwise.
    const { callback } = effect(
      "function C(){ useEffect(async () => { const r = await load(); return () => r.close() }, []) }",
    )
    expect(hasCleanup(callback)).toBe(false)
  })

  it("reports no cleanup for a bare early return", () => {
    const { callback } = effect("function C(){ useEffect(() => { if (!x) return; go() }, [x]) }")
    expect(hasCleanup(callback)).toBe(false)
  })
})

describe("nestedContextOf — the setter-in-a-subscription discriminator", () => {
  function contextOf(source: string, callee: string): string | null {
    const { callback } = effect(source)
    const call = callback
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => c.getExpression().getText() === callee)
    return nestedContextOf(call!, callback)
  }

  it("is null for a call in the effect body itself", () => {
    expect(contextOf("function C(){ useEffect(() => { setX(1) }, []) }", "setX")).toBe(null)
  })

  it("names the call whose callback the setter sits in", () => {
    expect(
      contextOf(
        "function C(){ useEffect(() => { setInterval(() => setNow(1), 60) }, []) }",
        "setNow",
      ),
    ).toBe("inside the callback passed to `setInterval()`")
  })

  it("describes two layers outermost first", () => {
    const text = contextOf(
      "function C(){ useEffect(() => { conn.on('m', (m) => items.forEach(() => setX(m))) }, []) }",
      "setX",
    )
    expect(text).toBe(
      "inside the callback passed to `conn.on()`, inside the callback passed to `items.forEach()`",
    )
  })
})

describe("externalReferences — handles on things React does not own", () => {
  it("reports the access chain as written, not a bare global", () => {
    const { callback } = effect(
      "function C(){ useEffect(() => { window.addEventListener('online', u); return () => window.removeEventListener('online', u) }, []) }",
    )
    expect(externalReferences(callback)).toEqual([
      "window.addEventListener",
      "window.removeEventListener",
    ])
  })

  it("reports a browser constructor", () => {
    const { callback } = effect(
      "function C(){ useEffect(() => { const o = new ResizeObserver(() => {}); return () => o.disconnect() }, []) }",
    )
    expect(externalReferences(callback)).toEqual(["new ResizeObserver"])
  })

  it("reports `ref.current` only when the ref came from React's useRef", () => {
    const fromReact = effect(
      "function C(){ const box = useRef(null); useEffect(() => { box.current.focus() }, []) }",
    )
    // The handle, not the whole chain: what is done with it is already a
    // call in `effect_body.calls`.
    expect(externalReferences(fromReact.callback)).toEqual(["box.current"])

    const notARef = effect(
      "function C(){ const box = { current: null }; useEffect(() => { box.current.focus() }, []) }",
    )
    expect(externalReferences(notARef.callback)).toEqual([])
  })

  it("reports nothing for an effect that only touches React state", () => {
    const { callback } = effect(
      "function C({ products }){ const [f, setF] = useState([]); useEffect(() => { setF(products.filter(p => p.ok)) }, [products]) }",
    )
    expect(externalReferences(callback)).toEqual([])
  })
})

describe("readsOutsideDeps — a fact, never a finding", () => {
  function reads(source: string): string[] {
    const { call, callback, unit } = effect(source)
    const { deps } = depsKindOf(call)
    return readsOutsideDeps(callback, deps === null ? null : dependencyRoots(call), unit)
  }

  it("compares on roots, so `[data.items]` covers a read of `data`", () => {
    const { call, callback, unit } = effect(
      "function C({ data }){ useEffect(() => { send(data) }, [data.items]) }",
    )
    expect(dependencyRoots(call)).toEqual(["data"])
    expect(readsOutsideDeps(callback, dependencyRoots(call), unit)).toEqual([])
  })

  it("reports a prop read by an effect with empty deps", () => {
    expect(
      reads("function C({ roomId }){ useEffect(() => { connect(roomId) }, []) }"),
    ).toEqual(["roomId"])
  })

  it("says nothing about a value that is listed", () => {
    expect(reads("function C({ roomId }){ useEffect(() => { connect(roomId) }, [roomId]) }")).toEqual(
      [],
    )
  })

  it("excludes setters and refs, whose identity React guarantees", () => {
    expect(
      reads(
        "function C(){ const [n, setN] = useState(0); const box = useRef(null); useEffect(() => { setN(1); box.current = 2 }, []) }",
      ),
    ).toEqual([])
  })

  it("excludes names the effect declares itself", () => {
    expect(reads("function C(){ useEffect(() => { const local = 1; use(local) }, []) }")).toEqual([])
  })

  it("is empty when there is no dependency array to be outside of", () => {
    expect(reads("function C({ roomId }){ useEffect(() => { connect(roomId) }) }")).toEqual([])
  })
})

describe("isReactEffectCallback", () => {
  it("is true for the first argument of React's useEffect and false elsewhere", () => {
    const { callback } = effect("function C(){ useEffect(() => { go() }, []) }")
    expect(isReactEffectCallback(callback)).toBe(true)

    const file = parse("function C(){ const f = () => {}; useMemo(() => 1, []) }")
    const arrow = file.getDescendantsOfKind(SyntaxKind.ArrowFunction)[0]!
    expect(isReactEffectCallback(arrow)).toBe(false)
  })
})

/* ── state-setters.ts ────────────────────────────────────────────────────── */

describe("stateSetters — what the unit itself declares", () => {
  it("reads a useState pair with its initial value", () => {
    const file = parse("function C(){ const [count, setCount] = useState(0) }")
    const unit = file.getFunctionOrThrow("C")
    expect(stateSetters(unit).map((s) => ({ ...s, setter: s.setter?.getText() ?? null }))).toEqual([
      { value: "count", setter: "setCount", hook: "useState", initial: "0" },
    ])
  })

  it("takes useReducer's second argument as the initial state", () => {
    const file = parse("function C(){ const [s, dispatch] = useReducer(reducer, { a: 1 }) }")
    const unit = file.getFunctionOrThrow("C")
    const [found] = stateSetters(unit)
    expect(found?.hook).toBe("useReducer")
    expect(found?.initial).toBe("{ a: 1 }")
  })

  it("ignores state declared inside a nested callback", () => {
    const file = parse(
      "function C(){ const [a, setA] = useState(0); const f = () => { const [b, setB] = useState(1) } }",
    )
    const unit = file.getFunctionOrThrow("C")
    expect(stateSetters(unit).map((s) => s.value)).toEqual(["a"])
  })
})

describe("writeContextOf — where a state write happens", () => {
  function contexts(source: string): { within: string; insideEffect: boolean }[] {
    const file = parse(source)
    const unit = file.getFunctionOrThrow("C")
    const setter = stateSetters(unit)[0]?.setter
    return writeSitesOf(setter!, unit).map((w) => ({ within: w.within, insideEffect: w.insideEffect }))
  }

  it("classifies a write during render", () => {
    expect(contexts("function C(){ const [a, setA] = useState(0); setA(1) }")).toEqual([
      { within: "render", insideEffect: false },
    ])
  })

  it("classifies a write in the effect body and one nested inside a listener", () => {
    expect(
      contexts(
        "function C(){ const [a, setA] = useState(0); useEffect(() => { setA(1); window.addEventListener('x', () => setA(2)) }, []) }",
      ),
    ).toEqual([
      { within: "effect", insideEffect: true },
      // The nested one is not *in* the effect callback, but it is *inside* the
      // effect — which is exactly the distinction external_store turns on.
      { within: "callback", insideEffect: true },
    ])
  })

  it("recognises the three handler shapes", () => {
    expect(
      contexts(
        "function C(){ const [a, setA] = useState(0); return <button onClick={() => setA(1)}/> }",
      ),
    ).toEqual([{ within: "handler", insideEffect: false }])

    expect(
      contexts("function C(){ const [a, setA] = useState(0); const handleClick = () => setA(1) }"),
    ).toEqual([{ within: "handler", insideEffect: false }])

    expect(
      contexts(
        "function C(){ const [a, setA] = useState(0); const onPick = useCallback(() => setA(1), []) }",
      ),
    ).toEqual([{ within: "handler", insideEffect: false }])
  })

  it("falls back to `callback` for a function that is neither", () => {
    expect(
      contexts("function C(){ const [a, setA] = useState(0); items.forEach(() => setA(1)) }"),
    ).toEqual([{ within: "callback", insideEffect: false }])
  })

  it("carries the setter argument, which is what `key_prop` is read off", () => {
    const file = parse("function C(){ const [d, setD] = useState(''); useEffect(() => { setD('') }, [id]) }")
    const unit = file.getFunctionOrThrow("C")
    expect(writeSitesOf(stateSetters(unit)[0]!.setter!, unit)[0]?.argument).toBe("''")
  })

  it("classifies a write at module scope as `other`", () => {
    const unit = parse("function C(){ }").getFunctionOrThrow("C")
    const moduleCall = parse("setA(1)").getDescendantsOfKind(SyntaxKind.CallExpression)[0]!
    expect(writeContextOf(moduleCall, unit)).toEqual({ within: "other", insideEffect: false })
  })
})

/* ── body-calls.ts ───────────────────────────────────────────────────────── */

describe("classifyCall — what the effect body reaches", () => {
  function calls(source: string, extra: Record<string, string> = {}): BodyCall[] {
    const { callback, unit, setters } = effect(source, extra)
    return callback
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((call) => classifyCall(call, unit, setters, callback))
  }

  it("classifies a state setter of this unit", () => {
    const [call] = calls(
      "function C({ products }){ const [f, setF] = useState([]); useEffect(() => { setF(products) }, [products]) }",
    )
    expect(call?.kind).toBe("state-setter")
    expect(call?.inputs).toEqual(["products"])
  })

  it("classifies a destructured prop callback, and a custom hook's argument the same way", () => {
    const [component] = calls(
      "function C({ onChange }){ const [on, setOn] = useState(false); useEffect(() => { onChange(on) }, [on, onChange]) }",
    )
    expect(component?.kind).toBe("prop-callback")
    expect(component?.inputs).toEqual(["on"])

    const [hook] = calls(
      "function useThing(onDone){ useEffect(() => { onDone(1) }, [onDone]) }",
    )
    expect(hook?.kind).toBe("prop-callback")
  })

  it("classifies a same-file function and an imported one, naming the module", () => {
    const [same] = calls("function go(){}\nfunction C(){ useEffect(() => { go() }, []) }")
    expect(same?.kind).toBe("same-file")

    const [imported] = calls(
      'import { fetchProduct } from "./_api"\nfunction C(){ useEffect(() => { fetchProduct(1) }, []) }',
      { "_api.ts": "export function fetchProduct(id){ return Promise.resolve(id) }" },
    )
    expect(imported?.kind).toBe("imported")
    expect(imported?.from).toBe("./_api")
  })

  it("classifies a hook result through both a bare call and a member call", () => {
    const [bare] = calls(
      'import { useThing } from "./_hooks"\nfunction C(){ const [run] = useThing(); useEffect(() => { run() }, []) }',
      { "_hooks.ts": "export function useThing(){ return [() => {}] }" },
    )
    expect(bare?.kind).toBe("hook-result")
    expect(bare?.via).toBe("useThing")

    const [member] = calls(
      'import { useQ } from "./_hooks"\nfunction C(){ const q = useQ(); useEffect(() => { q.refetch() }, []) }',
      { "_hooks.ts": "export function useQ(){ return { refetch(){} } }" },
    )
    expect(member?.kind).toBe("hook-result")
    expect(member?.via).toBe("useQ")
  })

  it("classifies globals — a member of `window`, and an ambient free function", () => {
    const found = calls(
      "function C(){ useEffect(() => { window.scrollTo(0, 0); setTimeout(() => {}, 10) }, []) }",
    )
    expect(found.map((c) => [c.callee, c.kind])).toEqual([
      ["window.scrollTo", "global"],
      ["setTimeout", "global"],
    ])
  })

  it("classifies an unreachable callee as unresolved rather than guessing", () => {
    const [call] = calls('import { go } from "./nowhere"\nfunction C(){ useEffect(() => { go() }, []) }')
    expect(call?.kind).toBe("unresolved")
  })

  it("classifies a method on a local object as a member", () => {
    const found = calls(
      "function C({ roomId }){ useEffect(() => { const c = connect(roomId); c.on('m', () => {}); return () => c.close() }, [roomId]) }",
    )
    expect(found.find((c) => c.callee === "c.on")?.kind).toBe("member")
  })

  it("carries the nesting for a setter inside a subscription", () => {
    const found = calls(
      "function C(){ const [m, setM] = useState([]); useEffect(() => { conn.on('m', (x) => setM(p => [...p, x])) }, []) }",
    )
    const setter = found.find((c) => c.kind === "state-setter")
    expect(setter?.nested).toBe("inside the callback passed to `conn.on()`")
  })
})

describe("hookResultsOf — the hook name is what tells a query from a toggle", () => {
  it("carries binding, hook and module for each bound name", () => {
    const file = parse(
      'import { useGetProductQuery } from "./_gen"\nfunction C(){ const { data, loading } = useGetProductQuery() }',
      { "_gen.ts": "export function useGetProductQuery(){ return { data: null, loading: false } }" },
    )
    expect(hookResultsOf(file.getFunctionOrThrow("C"))).toEqual([
      { binding: "data", hook: "useGetProductQuery", from: "./_gen" },
      { binding: "loading", hook: "useGetProductQuery", from: "./_gen" },
    ])
  })

  it("keeps two same-named bindings apart by the hook that produced them", () => {
    const file = parse(
      'import { useToggle } from "./_h"\nfunction C(){ const [data] = useToggle() }',
      { "_h.ts": "export function useToggle(){ return [false] }" },
    )
    expect(hookResultsOf(file.getFunctionOrThrow("C"))[0]?.hook).toBe("useToggle")
  })

  it("leaves out React's own state and derived hooks, which `state` already covers", () => {
    const file = parse(
      "function C(){ const [a, setA] = useState(0); const r = useRef(null); const m = useMemo(() => 1, []); const c = useContext(Ctx) }",
    )
    expect(hookResultsOf(file.getFunctionOrThrow("C")).map((h) => h.binding)).toEqual(["c"])
  })
})

describe("bodyCalls — the ambient rule, in the shape rule #2 consumes it", () => {
  it("inlines a same-file callee, names a cross-file one, and passes over ambients", () => {
    const { callback, unit, setters } = effect(
      [
        'import { slugify } from "./_helpers"',
        "function local(){ return 1 }",
        "function C(){ useEffect(() => { local(); slugify('a'); setTimeout(() => {}, 1); parseInt('3') }, []) }",
      ].join("\n"),
      { "_helpers.ts": "export function slugify(s){ return s }" },
    )
    const { resolved, unresolved } = bodyCalls(callback, unit, setters)
    expect(Object.keys(resolved)).toEqual(["local"])
    expect(unresolved).toEqual(["slugify"])
  })
})
