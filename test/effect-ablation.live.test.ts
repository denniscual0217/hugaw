import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Project, SyntaxKind, ts } from "ts-morph"
import type { CallExpression } from "ts-morph"
import { describe, expect, it } from "vitest"
import type { ChoiceAnswer, NoulAnswer } from "../src/core/index.js"
import { unitOf } from "../src/adapters/typescript/units.js"
import type { FunctionLike } from "../src/adapters/typescript/types.js"
import { isReactApi } from "../src/plugins/react/analysis/react-imports.js"
import { componentSource } from "../src/plugins/react/slices/component-source.js"
import { componentStateOf } from "../src/plugins/react/slices/component-state.js"
import { effectBodyOf } from "../src/plugins/react/slices/effect-body.js"
import { effectCallOf } from "../src/plugins/react/slices/effect-call.js"
import { noul } from "../src/core/index.js"
import { KEEP_FAMILY, effectQuestions } from "../src/plugins/react/rules/effect-questions.js"
import { KEEP_FAMILY_MASS_MAX } from "../src/plugins/react/rules/useeffect-alternatives.js"
import { TypeSafeJudge } from "../src/judge/typesafe.js"

/**
 * The ablation that decides rule #2's shape, run before `decide` exists.
 *
 * Case 1 is a design blocker in the plan's own words: if the Noul does not
 * judge a legitimate WebSocket effect as justified, the gate is wrong and the
 * rule is a machine for deleting working code. Nothing downstream of that
 * answer is worth building first, so this runs against the two questions
 * alone, with no thresholds, no `decide` and no rule registered.
 *
 * Synthetic sources only. The target repository is an employer's codebase and
 * sending it to TypeSafe has not been approved.
 */

const live = process.env["HUGAW_LIVE"] === "1" && (process.env["TYPESAFE_API_KEY"] ?? "") !== ""

interface Case {
  readonly n: number
  readonly name: string
  readonly expect: string
  readonly source: string
  readonly extra?: Record<string, string>
  /** Which `useEffect` in the source to judge, when there is more than one. */
  readonly pick?: number
}

/** Shared by cases 22 and 23: one component, two links of one chain. */
const CHAIN_SOURCE = `import { useEffect, useState } from "react"

export function Counter() {
  const [count, setCount] = useState(0)
  const [isTen, setIsTen] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (count === 10) setIsTen(true)
  }, [count])

  useEffect(() => {
    if (isTen) setMessage("Reached ten!")
  }, [isTen])

  return (
    <div>
      <button onClick={() => setCount(count + 1)}>+1</button>
      {message}
    </div>
  )
}`

const CASES: readonly Case[] = [
  {
    n: 1,
    name: "websocket chat room",
    expect: "noul >= 0.7, keep_effect (BLOCKER below 0.4)",
    source: `import { useEffect, useState } from "react"

function createConnection(roomId) {
  const socket = new WebSocket("wss://chat.example.com/" + roomId)
  return {
    connect() { socket.addEventListener("open", () => {}) },
    on(event, handler) { socket.addEventListener(event, handler) },
    disconnect() { socket.close() },
  }
}

export function ChatRoom({ roomId }) {
  const [messages, setMessages] = useState([])
  useEffect(() => {
    const connection = createConnection(roomId)
    connection.on("message", (m) => setMessages((prev) => [...prev, m]))
    connection.connect()
    return () => connection.disconnect()
  }, [roomId])
  return <ul>{messages.map((m) => <li key={m.id}>{m.text}</li>)}</ul>
}`,
  },
  {
    n: 2,
    name: "online/offline mirror (SKILL.md §11)",
    expect: "noul <= 0.3, external_store, NOT mount_effect",
    source: `import { useEffect, useState } from "react"

export function StatusBar() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine)
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])
  return <span>{isOnline ? "Online" : "Offline"}</span>
}`,
  },
  {
    n: 3,
    name: "setInterval clock",
    expect: "noul high",
    source: `import { useEffect, useState } from "react"

export function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return <time>{now.toISOString()}</time>
}`,
  },
  {
    n: 4,
    name: "derived state (SKILL.md §1)",
    expect: "noul <= 0.2, render_computation",
    source: `import { useEffect, useState } from "react"

export function ProductList({ products }) {
  const [filtered, setFiltered] = useState([])
  useEffect(() => {
    setFiltered(products.filter((p) => p.inStock))
  }, [products])
  return <ul>{filtered.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
}`,
  },
  {
    n: 5,
    name: "selection reset on items (SKILL.md §6)",
    expect: "derive_by_id; key_prop mass measured",
    source: `import { useEffect, useState } from "react"

export function ItemList({ items }) {
  const [selection, setSelection] = useState(null)
  useEffect(() => {
    setSelection(null)
  }, [items])
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id} onClick={() => setSelection(i)}>
          {i.name}
        </li>
      ))}
    </ul>
  )
}`,
  },
  {
    n: 6,
    name: "profile reset on userId (SKILL.md §5)",
    expect: "key_prop",
    source: `import { useEffect, useState } from "react"

export function Profile({ userId }) {
  const [comment, setComment] = useState("")
  const [draft, setDraft] = useState("")
  useEffect(() => {
    setComment("")
    setDraft("")
  }, [userId])
  return (
    <form>
      <input value={comment} onChange={(e) => setComment(e.target.value)} />
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
    </form>
  )
}`,
  },
  {
    n: 7,
    name: "LikeButton flag (SKILL.md §4) — matches two criteria at once",
    expect: "event_handler; collapse_to_handler mass measured",
    source: `import { useEffect, useState } from "react"

function postLike() {
  return fetch("/api/likes", { method: "POST" })
}

export function LikeButton() {
  const [liked, setLiked] = useState(false)
  useEffect(() => {
    if (liked) {
      postLike()
      setLiked(false)
    }
  }, [liked])
  return <button onClick={() => setLiked(true)}>Like</button>
}`,
  },
  {
    n: 8,
    name: "notify parent of a toggle (SKILL.md §8)",
    expect: "notify_parent",
    source: `import { useEffect, useState } from "react"

export function Toggle({ onChange }) {
  const [isOn, setIsOn] = useState(false)
  useEffect(() => {
    onChange(isOn)
  }, [isOn, onChange])
  function handleClick() {
    setIsOn(!isOn)
  }
  return <button onClick={handleClick}>{isOn ? "on" : "off"}</button>
}`,
  },
  {
    n: 9,
    name: "child bubbles query data up (SKILL.md §9)",
    expect: "lift_fetch",
    source: `import { useEffect } from "react"
import { useGetProductQuery } from "./_generated"

export function ProductPanel({ productId, onFetched }) {
  const { data } = useGetProductQuery({ variables: { productId } })
  useEffect(() => {
    if (data) onFetched(data)
  }, [data, onFetched])
  return <div>{data ? data.product.name : "…"}</div>
}`,
    extra: {
      "_generated.ts": `export function useGetProductQuery(options) {
  return { data: null, loading: false }
}`,
    },
  },
  {
    n: 10,
    name: "fetch on id change, callee cross-file (SKILL.md §3)",
    expect: "noul low, data_library; unresolved callee must not raise the noul",
    source: `import { useEffect, useState } from "react"
import { fetchProduct } from "./_api"

export function ProductPage({ productId }) {
  const [product, setProduct] = useState(null)
  useEffect(() => {
    fetchProduct(productId).then(setProduct)
  }, [productId])
  return <h1>{product ? product.name : "…"}</h1>
}`,
    extra: {
      "_api.ts": `export function fetchProduct(id) {
  return fetch("/api/products/" + id).then((r) => r.json())
}`,
    },
  },
  {
    n: 11,
    name: "auth from storage on mount (SKILL.md §10)",
    expect: "module_init — the case correction 1 exists for",
    source: `import { useEffect } from "react"
import { authClient } from "./_auth"

function loadAuthFromStorage() {
  const token = localStorage.getItem("auth_token")
  authClient.configure({ token })
}

export function App({ children }) {
  useEffect(() => {
    loadAuthFromStorage()
  }, [])
  return <main>{children}</main>
}`,
    extra: {
      "_auth.ts": `export const authClient = { configure(options) {} }`,
    },
  },
  {
    n: 12,
    name: "ResizeObserver on mount (SKILL.md §12)",
    expect: "noul >= 0.7, mount_effect — sets MOUNT_JUSTIFIED_MIN",
    source: `import { useEffect, useRef, useState } from "react"

export function Panel({ children }) {
  const boxRef = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(boxRef.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={boxRef}>{children}</div>
}`,
  },
  {
    n: 13,
    name: "document.title",
    expect: "noul high, silent",
    source: `import { useEffect } from "react"

export function PageTitle({ title }) {
  useEffect(() => {
    document.title = title
  }, [title])
  return null
}`,
  },
  {
    n: 14,
    name: "effect inside a custom hook — no parent, no props",
    expect: "unknown: notify_parent and lift_fetch are defined against a parent",
    source: `import { useEffect, useState } from "react"

export function useThing(onDone) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    onDone(value)
  }, [value, onDone])
  return setValue
}`,
  },
  {
    n: 15,
    name: "no dependency array at all",
    expect: "unknown: no option describes this shape",
    source: `import { useEffect } from "react"

function trackPageView(page) {
  window.analytics.track("page_view", { page })
}

export function Tracker({ page }) {
  useEffect(() => {
    trackPageView(page)
  })
  return null
}`,
  },
  {
    n: 16,
    name: "async callback with .then(setX)",
    expect: "unknown: cleanup detection gives up on an async callback",
    source: `import { useEffect, useState } from "react"
import { loadThing } from "./_api"

export function Thing({ id }) {
  const [data, setData] = useState(null)
  useEffect(async () => {
    await Promise.resolve()
    loadThing(id).then(setData)
  }, [id])
  return <pre>{JSON.stringify(data)}</pre>
}`,
    extra: {
      "_api.ts": `export function loadThing(id) {
  return fetch("/api/things/" + id).then((r) => r.json())
}`,
    },
  },
  {
    n: 17,
    // Case 12 as the plan specifies it cannot set MOUNT_JUSTIFIED_MIN: a
    // ResizeObserver that writes the measured width into state is *also* a
    // textbook `useSyncExternalStore`, so the two options are competing on
    // merit rather than on the mount-ness the threshold is about. This is the
    // same shape with the confound removed — a third-party widget owned for
    // the instance's lifetime, no state written, nothing to mirror.
    name: "third-party widget on mount, no state written (control for 12)",
    expect: "mount_effect — the un-confounded MOUNT_JUSTIFIED_MIN case",
    source: `import { useEffect, useRef } from "react"
import { createEditor } from "./_editor"

export function MarkdownEditor({ initialValue }) {
  const hostRef = useRef(null)
  useEffect(() => {
    const editor = createEditor(hostRef.current, { value: initialValue })
    editor.focus()
    return () => editor.destroy()
  }, [])
  return <div ref={hostRef} />
}`,
    extra: {
      "_editor.ts": `export function createEditor(host, options) {
  return { focus() {}, destroy() {} }
}`,
    },
  },
  {
    n: 18,
    name: "focus a conditionally rendered input (the Modal shape)",
    expect: "ref_callback",
    source: `import { useEffect, useRef } from "react"

export function Modal({ isOpen }) {
  const inputRef = useRef(null)
  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])
  return isOpen ? <input ref={inputRef} /> : null
}`,
  },
  {
    n: 19,
    // The negative that decides whether the option is safe to ship. A ref
    // callback fires when the node appears; here the node never goes away,
    // so it would fire once at mount and never again.
    name: "focus an always-mounted input, keyed to another prop",
    expect: "NOT ref_callback",
    source: `import { useEffect, useRef } from "react"

export function SearchPanel({ activeTab }) {
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [activeTab])
  return <input ref={inputRef} placeholder="Search" />
}`,
  },
  {
    n: 20,
    name: "scroll a conditionally rendered node into view",
    expect: "ref_callback, and not pinned to focus()",
    source: `import { useEffect, useRef } from "react"

export function ErrorBanner({ error }) {
  const boxRef = useRef(null)
  useEffect(() => {
    if (error) boxRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [error])
  return error ? <div ref={boxRef}>{error}</div> : null
}`,
  },
  {
    n: 21,
    name: "measure a node on mount and store the width",
    expect: "unknown: the shape most likely to drift",
    source: `import { useEffect, useRef, useState } from "react"

export function Chart({ data }) {
  const hostRef = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    setWidth(hostRef.current.offsetWidth)
  }, [])
  return <div ref={hostRef}>{width} {data.length}</div>
}`,
  },
  {
    n: 22,
    // The chain, first link. `setCount` in an `onClick` is what makes this a
    // chain rather than a pair of derivations: without a handler starting it,
    // `render_computation` is the better answer and the ordering flips.
    name: "cascading state, first effect (count -> isTen)",
    expect: "collapse_to_handler, render_computation runner-up",
    source: CHAIN_SOURCE,
  },
  {
    n: 23,
    name: "cascading state, second effect (isTen -> message)",
    expect: "collapse_to_handler, render_computation runner-up",
    source: CHAIN_SOURCE,
    pick: 1,
  },
]

interface Summary {
  readonly mode: string
  readonly modeMass: number
  readonly runnerUp: string | null
  readonly runnerUpMass: number
  readonly keepFamilyMass: number
}

/**
 * Mode and summed keep-family mass.
 *
 * Both, because they answer different questions and the plan conflated them.
 * `{keep .30, effect_event .12, mount .05, render .31, memo .22}` has a
 * delete-family mode and 47% of its mass on keeping the effect; gating on the
 * mode reports it and prints "30%".
 */
function summarise(probabilities: Readonly<Record<string, number>>): Summary {
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  const keepFamilyMass = ranked
    .filter(([label]) => KEEP_FAMILY.has(label))
    .reduce((total, [, mass]) => total + mass, 0)
  return {
    mode: ranked[0]?.[0] ?? "<none>",
    modeMass: ranked[0]?.[1] ?? 0,
    runnerUp: ranked[1]?.[0] ?? null,
    runnerUpMass: ranked[1]?.[1] ?? 0,
    keepFamilyMass,
  }
}

function buildState(testCase: Case): Record<string, unknown> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      strict: false,
      lib: ["lib.dom.d.ts", "lib.es2022.d.ts"],
    },
  })
  for (const [name, text] of Object.entries(testCase.extra ?? {})) project.createSourceFile(name, text)
  const file = project.createSourceFile(`case${testCase.n}.tsx`, testCase.source)

  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c: CallExpression) => isReactApi(c.getExpression(), "useEffect"))[testCase.pick ?? 0]
  if (!call) throw new Error(`case ${testCase.n}: no React useEffect`)
  const unit = unitOf(call) as FunctionLike

  // The unit slice never touches `program`; the narrowing plus the cast keeps
  // the ablation on the shipped extractor rather than a copy of it.
  if (componentSource.scope !== "unit") throw new Error("component_source is unit-scoped")

  return {
    component_source: componentSource.extract({ unit, unitKey: "", program: null as never }),
    component_state: componentStateOf(unit),
    effect_call: effectCallOf(call, unit),
    effect_body: effectBodyOf(call, unit),
  }
}

/**
 * The two Noul wordings this ablation measured and the rule then rejected.
 *
 * Neither ships. They are kept here, and only here, because CALIBRATION.md
 * cites their numbers as the reason rule #2 asks one question instead of two:
 * a claim that a signal was measured and discarded is worth nothing if the
 * measurement cannot be run again. `justifiedV1` restructured both sides
 * around one axis; `justifiedV2` is the plan's original enumerating phrasing.
 * A Noul added to a request that already carries the state costs almost
 * nothing, so both were measured rather than argued about.
 */
const justifiedV1 = noul(
  "Is `useEffect` the only way to do what the effect in `effect_call` does, or would some other primitive — or some other place entirely — do the same job? Judge from what `effect_body` actually calls and touches, from `component_state`, and from `component_source`.",
  {
    true: "Nothing else does this job. The effect reaches a system React does not own — opening, feeding or tearing down a connection, a subscription or a timer that produces new information over time; driving an imperative handle, a measurement, focus or scroll; reporting to something outside the app — and it has to keep doing so for as long as this component is on screen, undoing itself when it leaves. These are examples; the test is that no other place could do the whole job.",
    false: "Something else does this job, and the effect is a detour around it. Usually another React primitive: computing during render, doing the work in the handler that caused it, a `key` that resets state, `useSyncExternalStore` for reading an external value, a data-fetching hook for a request, a call made where the state is set rather than after the render. Sometimes it is not React at all — one-time application or SDK setup belongs at module scope, runs once per page load rather than once per mount, and is tied to no component being on screen. These too are examples; the test is that some other place does the whole job.",
  },
)

const justifiedV2 = noul(
  "Is the effect in `effect_call` a genuine synchronisation with a system outside React that has to happen because this component is on screen? Judge from what `effect_body` actually calls and touches, from `component_state`, and from `component_source`.",
  {
    true: "It sets up, drives or tears down something React does not own — a connection or subscription that accumulates events, an imperative library or DOM handle, focus or scroll, analytics, a timer that produces new information — and no library hook already covers that job",
    false:
      "Everything it does could be expressed without it: it writes state computable from props or state, it reacts to a user action a handler could perform, it resets state a key would reset, it notifies a parent, it fetches data a data-fetching hook would fetch, or it mirrors the current value of an external source into state, which useSyncExternalStore already covers",
  },
)

describe.skipIf(!live)("rule #2 ablation — the two questions, live", () => {
  it("records (noul, mode, mode mass, keep-family mass, runner-up) per case", async () => {
    const judge = new TypeSafeJudge({ model: "jev-1.13.0" })
    const rows: Record<string, unknown>[] = []

    for (const testCase of CASES) {
      const state = buildState(testCase)
      const response = await judge.judge({
        id: `ablation#${testCase.n}`,
        model: "jev-1.13.0",
        state: state as never,
        questions: {
          ...effectQuestions,
          justified_v1: justifiedV1,
          justified_v2: justifiedV2,
        } as never,
      })
      if (response === null) throw new Error(`case ${testCase.n}: no response`)

      const noulAnswer = response.answers["justified_v1"] as NoulAnswer
      const v2Answer = response.answers["justified_v2"] as NoulAnswer
      const choiceAnswer = response.answers["replacement"] as ChoiceAnswer
      const summary = summarise(choiceAnswer.probabilities)

      rows.push({
        n: testCase.n,
        name: testCase.name,
        expected: testCase.expect,
        noul: Number(noulAnswer.noul.toFixed(3)),
        noulV2: Number(v2Answer.noul.toFixed(3)),
        ...summary,
        modeMass: Number(summary.modeMass.toFixed(3)),
        runnerUpMass: Number(summary.runnerUpMass.toFixed(3)),
        keepFamilyMass: Number(summary.keepFamilyMass.toFixed(3)),
        choiceConfidence: Number(choiceAnswer.confidence.toFixed(3)),
        inputTokens: response.usage?.input_tokens ?? 0,
        probabilities: Object.fromEntries(
          Object.entries(choiceAnswer.probabilities)
            .filter(([, mass]) => mass >= 0.005)
            .sort((a, b) => b[1] - a[1])
            .map(([label, mass]) => [label, Number(mass.toFixed(3))]),
        ),
        depsKind: (state["effect_call"] as { depsKind: string }).depsKind,
        hasCleanup: (state["effect_call"] as { hasCleanup: boolean }).hasCleanup,
      })
    }

    const out = process.env["HUGAW_ABLATION_OUT"] ?? join(tmpdir(), "hugaw-ablation.json")
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(rows, null, 2))

    expect(rows).toHaveLength(CASES.length)

    // The gate the rule actually ships, asserted over every case: the two
    // families must stay on opposite sides of KEEP_FAMILY_MASS_MAX. This is
    // the separation the Noul could not produce, and the only thing in this
    // file that is a claim rather than a record.
    for (const row of rows as { n: number; keepFamilyMass: number }[]) {
      // Case 21 is exploratory — a DOM measurement written into state is
      // genuinely arguable between keeping and replacing, and pinning it
      // here would be asserting an answer we have not decided.
      if (row.n === 21) continue
      const keeps = [1, 3, 13, 15, 17, 19].includes(row.n)
      if (keeps) expect(row.keepFamilyMass, `case ${row.n} keeps`).toBeGreaterThan(KEEP_FAMILY_MASS_MAX)
      else expect(row.keepFamilyMass, `case ${row.n} deletes`).toBeLessThan(KEEP_FAMILY_MASS_MAX)
    }
  }, 240_000)
})
