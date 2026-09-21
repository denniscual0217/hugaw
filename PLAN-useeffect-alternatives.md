# Plan: `react/useeffect-alternatives`

## 0. Orientation and the calls made where the brief left room

The memo rule is the template; match its shape exactly: `select` via `isReactApi`, no `skip`,
four slices (one unit-scoped, three candidate-scoped), module-constant thresholds with
reasoning comments, `buildMessage(facts)` with caveats only for real blind spots,
mode-not-expected-value for phrasing, a table-driven unit test on `decide()` plus a small
e2e test through `runFixture`.

Three calls made explicitly, because the constraints interact in ways a literal reading
cannot satisfy:

1. **`mount_effect` and `effect_event` are "keep" outcomes, and the Noul gate structurally
   excludes them.** Both describe effects that *are* genuine external synchronisation (the
   Noul's `true`), so gating on `noul <= JUSTIFIED_MAX` means neither can ever be reported.
   Resolved differently for each. `mount_effect` becomes a second, positively-gated finding
   (`wrapMountEffect`): reported only when the Noul says *strongly* justified **and** the
   dependency array is literally `[]` — a static fact, but one used to *report a rewrap*, not
   to *suppress a judgment*, which is the direction the no-`skip` decision cares about.
   `effect_event` stays in the Choice (it must, or it cannibalises `keep_effect`) but is
   **not reported in this iteration**: a finding that says "keep the effect but extract
   something" without naming the over-reactive dep is not actionable, and naming it needs its
   own calibrated signal. The ablation measures how often it becomes the mode; a third Noul
   is sketched as the follow-up if it does.
2. **Noul/Choice disagreement suppresses.** If the Noul says unjustified but the Choice mode
   lands in the keep family, the evidence is not one-sided; the burden is on the linter, so
   `decide` returns null. Same asymmetry as the memo rule.
3. **The `context` string is not where hook import paths go.** `context` rides on the wire and
   costs tokens on every request; an import path is a fact the *message* needs, not the model.
   `messageSuffix` already delivers exactly this at zero wire cost. `context` stays reserved
   for facts that should move the *verdict*. No new rule option.

Boundary decisions: `useLayoutEffect` (20 in the target) and `useInsertionEffect` are **not
selected** in this iteration — their existence is usually justified by timing, the skill's
matrix does not address them, and adding them later is one line in `select` plus a `timing`
field. `useEffect` imported from anywhere but `react` is not a candidate.

Target-repo facts (surveyed): 272 `useEffect` outside tests, 31 with `[]`, 25 with an
`exhaustive-deps` suppression nearby, 92 files named `use*` (roughly a third of effects live
in custom hooks, so the unit is a hook, not a component). Apollo is consumed through
graphql-codegen `near-operation-file` output: `src/modules/**/graphql/generated/*.graphql.ts`
exports `useGetXQuery` / `useXLazyQuery` / `useXMutation` wrapping `Apollo.useQuery`. So
"already uses a data library" shows up in an effect body as a call to a **hook result**
(`refetch()`, a mutation tuple's function) — the `effect_body` slice must classify those as
`hook-result` with the hook name, or the model cannot tell `lift_fetch` from `data_library`.
The three local hooks are at `src/modules/core/hooks/{useMountEffect,useEffectEvent,useLinkedState}.ts`.

## 1. Files

### New

| File | Responsibility |
| --- | --- |
| `src/plugins/react/rules/useeffect-alternatives.ts` | The rule: thresholds, the two questions with full structured criteria, `EffectFacts`, `buildMessage`, `decide`. |
| `src/plugins/react/rules/effect-data.ts` | `EffectData` (mirror of `memo-data.ts`). |
| `src/plugins/react/rules/useeffect-alternatives.test.ts` | Threshold table, the 14-outcome message table, disagreement, either/or, caveats, `wrapMountEffect` — in-memory candidates. |
| `src/plugins/react/analysis/effects.ts` | Effect-call anatomy: callback resolution, deps kind, cleanup detection, nested-callback context, external handles, reads outside deps. |
| `src/plugins/react/analysis/state-setters.ts` | Which `useState`/`useReducer` setters the unit declares, and every write site with a classified context. |
| `src/plugins/react/analysis/body-calls.ts` | Classify every call inside a function body: setter / prop callback / same-file / imported / hook result / global / member / unresolved. |
| `src/plugins/react/slices/component-state.ts` | Unit slice `component_state`. |
| `src/plugins/react/slices/effect-call.ts` | Candidate slice `effect_call`. |
| `src/plugins/react/slices/effect-body.ts` | Candidate slice `effect_body`. |
| `fixtures/useeffect-alternatives/...` | Five fixtures + two `_` support files (section 7). |

### Modified

| File | Change |
| --- | --- |
| `src/core/questions.ts` | Widen `ChoiceQuestion` criteria from `string | null` to `ChoiceCriterion = string | JsonObject | null`. `instructions` stays `string` so `withContextCitation` is untouched. Score and Noul criteria stay strings. |
| `src/core/index.ts` | Export `ChoiceCriterion`. |
| `src/plugins/react/analysis/render-triggers.ts` | Export `baseIdentifierOf` (module-private today; needed to root deps and body reads). No behaviour change. |
| `src/plugins/react/slices/callee-sources.ts` | Extract the loop into `calleeSourcesIn(scope, filePath)`; `calleeSourcesOf(call)` becomes a wrapper. `functionBodyOf` exported for `body-calls.ts`. Memo behaviour unchanged. |
| `src/plugins/react/index.ts` | Register the rule and three new slices; re-export rule, `EffectFacts`, `EffectData`. |
| `src/react.ts` | Re-export the same. |
| `test/helpers/run-fixture.ts` | `rule` now selects **both** the fixture directory and, by default, the `ruleFilter` (`react/${rule}`); add `ruleFilter?: string | null` override (`null` = every rule). Without this, `should-pass/dep-array.tsx` and `member-access-dep-array.tsx` (which contain a `useEffect`) would pull the new rule into the memo suite's requests and its unscripted mock answers would land at `keep_effect`. |
| `src/plugins/react/index.test.ts` | Add the effect-rule e2e block, plus one explicit two-rules-one-request test over `dep-array.tsx` with `ruleFilter: null`. |
| `README.md` | New rule section; "one MVP rule" heading becomes "Rules". |
| `CALIBRATION.md` | Filled by the ablation, not by implementation. |

### Reuse

Reused unchanged: `isReactApi`, `importSourceOf`, `resolveDeclaration`, `referencesWithin`,
`unitOf`/`unitName`, `accessChainRoot`, `renderTriggers`, `isHookCall`/`hookNameOf`,
`truncate`, the `componentSource` slice, and the callee-resolution loop.
Deliberately **not** reused: `classifyUsage`/`usages.ts` (classifies consumers of a *value*;
this rule classifies *calls in a body*), `escapeOf`, `contextValueTagOf`, `isMemoComponentTag`,
`dependencyCoverage`.

## 2. Slices

Wire payload for one candidate: `component_source` (existing), `component_state` (new, unit),
`effect_call` (new, candidate), `effect_body` (new, candidate). Four, like the memo rule.

### `component_state` — unit scope

Unit scope because every effect in the component needs the same answer to "what state is
declared here and where else is it written". The memo rule keeps `renderTriggers` off the wire
because no question consults it; here a question *does*, so it goes on.

```ts
export type WriteContext = "render" | "effect" | "handler" | "callback" | "other"

export interface StateWrite {
  readonly line: number
  readonly within: WriteContext   // nearest enclosing function-like, classified
  readonly insideEffect: boolean  // any ancestor is a React effect callback
  readonly argument: string       // setter argument text, truncated to 160 chars
}

export interface DeclaredState {
  readonly value: string
  readonly setter: string | null
  readonly hook: "useState" | "useReducer"
  readonly initial: string | null
  readonly writes: readonly StateWrite[]
}

export interface ComponentState {
  readonly owner: { readonly name: string; readonly kind: "component" | "hook" | "other" }
  readonly props: readonly string[]
  readonly state: readonly DeclaredState[]
  readonly hookResults: readonly string[]
}
```

`within` classification: nearest function-like `f` of the call; `f === unit` -> `render`;
`f` is the first argument of a React effect -> `effect`; `f` initialises a JSX attribute named
`on*`, or its binding matches `/^(handle|on)[A-Z]/`, or it is the argument of `useCallback`
whose binding matches that -> `handler`; otherwise `callback`. This is what makes "flag state
set only in a handler" visible to `event_handler`, and "also written in a handler" visible to
`use_linked_state`.

`owner.kind`: `hook` when `unitName` matches `/^use[A-Z]/`, `component` when capitalised, else `other`.

### `effect_call` — candidate scope

```ts
export type DepsKind = "none" | "empty" | "list" | "unknown"

export interface EffectCallSlice {
  readonly line: number
  readonly endLine: number
  readonly source: string           // whole call, truncated to 4_000 chars
  readonly deps: readonly string[] | null
  readonly depsKind: DepsKind
  readonly hasCleanup: boolean
  readonly callback: "inline" | { readonly name: string; readonly resolved: boolean }
  readonly readsOutsideDeps: readonly string[]
}
```

`readsOutsideDeps` is a **fact, never a verdict**: it distinguishes `mount_effect`-plus-`key`
and `effect_event` shapes. The rule never reports it as a missing dep.

### `effect_body` — candidate scope

```ts
export type CallKind =
  | "state-setter" | "prop-callback" | "same-file" | "imported"
  | "hook-result" | "global" | "member" | "unresolved"

export interface BodyCall {
  readonly line: number
  readonly callee: string
  readonly kind: CallKind
  readonly via?: string             // hook name for hook-result
  readonly from?: string            // module specifier for imported
  readonly arguments: string        // truncated to 200 chars
  readonly inputs: readonly string[]
  readonly nested: string | null    // "inside the callback passed to `window.addEventListener()`"
}

export interface EffectBodySlice {
  readonly calls: readonly BodyCall[]
  readonly resolved: Record<string, string>
  readonly unresolved: readonly string[]
  readonly externals: readonly string[]
}
```

`externals`: access chains rooted at `window|document|navigator|location|history|localStorage|
sessionStorage|globalThis`; `new X(` for known browser constructors (`ResizeObserver`,
`IntersectionObserver`, `MutationObserver`, `WebSocket`, `EventSource`, `AbortController`,
`Audio`, `Image`, `Worker`) or an import; and `ref.current` where `ref` is bound from React's
`useRef`. Deduplicated, sorted.

`nested`: walk from the call up to the effect callback; describe each intervening function-like,
outermost first. **The single most important discriminator for the 57 setter-calling effects**:
`setDuration` inside a `setInterval` callback is a subscription, not derived state.

## 3. `select` and `EffectData`

```ts
export interface EffectData {
  readonly callback: ArrowFunction | FunctionExpression | FunctionDeclaration | null
  readonly callbackName: string | null
}
```

`select(file)`: every `CallExpression` with `isReactApi(call.getExpression(), "useEffect")`;
`data` from `effectCallbackOf(call)`. Unit is the runner's `unitOf(call)`.

```ts
// analysis/effects.ts
export function effectCallbackOf(call: CallExpression): EffectData
export function depsKindOf(call: CallExpression): { kind: DepsKind; deps: string[] | null }
export function hasCleanup(callback: FunctionLike): boolean
export function nestedContextOf(node: Node, callback: FunctionLike): string | null
export function externalReferences(callback: FunctionLike): string[]
export function readsOutsideDeps(callback: FunctionLike, deps: readonly string[] | null, unit: FunctionLike): string[]
export function isReactEffectCallback(fn: FunctionLike): boolean

// analysis/state-setters.ts
export interface StateSetter { readonly value: string; readonly setter: Identifier | null; readonly hook: "useState" | "useReducer"; readonly initial: string | null }
export function stateSetters(unit: FunctionLike): StateSetter[]
export function writeSitesOf(setter: Identifier, unit: FunctionLike): StateWrite[]
export function writeContextOf(call: CallExpression, unit: FunctionLike): { within: WriteContext; insideEffect: boolean }

// analysis/body-calls.ts
export function classifyCall(call: CallExpression, unit: FunctionLike, setters: readonly StateSetter[], callback: FunctionLike): BodyCall
export function bodyCalls(callback: FunctionLike, unit: FunctionLike): { calls: BodyCall[]; resolved: Record<string, string>; unresolved: string[] }

// callee-sources.ts refactor
export function calleeSourcesIn(scope: Node, filePath: string): CalleeSources
export function calleeSourcesOf(call: CallExpression): CalleeSources
export function functionBodyOf(declaration: Node): Node | null
```

One addition inside the loop: a declaration whose source file `isDeclarationFile()` is
classified ambient (global), not `unresolved` — otherwise `fetch` and `setTimeout` would
trigger the cross-file caveat on every fixture in a project with `lib.dom`.

## 4. `ask` — the criteria as shipped

```ts
type Criterion = { readonly description: string; readonly evidence: string; readonly contrast: string }
```

A `type` alias, not an `interface`, because an interface is not assignable to core's
index-signature `JsonObject`.

Fourteen options. Full text for each, in order (`keep_effect` first so the null hypothesis
anchors the list, then the derive family, the handler family, the fetch family, the store,
then the keep-variants):

**keep_effect** — description: "Keep it as written. It synchronises something React does not
own — a connection, a subscription that accumulates events, an imperative widget, a DOM
measurement, focus or scroll, analytics, a timer that produces new information — and it must
re-run when its dependencies change because each dependency is a reason to re-synchronise."
evidence: "`effect_body.externals` or a resolved callee that talks to a non-React system,
usually a cleanup, and dependencies that name what is being synchronised."
contrast: "Not `mount_effect`: this one has real dependencies and must re-run when they change.
Not `effect_event`: every dependency here is a trigger; none is merely read for its latest value."

**render_computation** — description: "Delete it and the state it writes. The value is a plain
function of props or state and should be computed inline during render — one render pass, no
stale frame, no loop hazard." evidence: "A `state-setter` call in `effect_body.calls` whose
`inputs` are props or state, with `nested` null, no externals, and that state written nowhere
else in `component_state.state[].writes`." contrast: "Not `use_memo`: the only difference is
cost, and this computation is cheap. Not `use_linked_state`: the value is never edited by the
user between changes of its inputs."

**use_memo** — description: "Delete it and the state it writes; compute the value during render
inside `useMemo`, because the transform is measurably expensive — a sort, groupBy, nested
iteration, or a known-heavy library call over a collection whose size is not bounded here."
evidence: "The same shape as `render_computation`, but the setter's argument or a resolved
callee body does heavy work." contrast: "Not `render_computation`: pick this only when the work
is heavy enough that recomputing every render is a real cost. Not `use_linked_state`: the state
is never edited independently of its inputs."

**use_linked_state** — description: "Replace the state and the effect with a linked state — a
hook of the shape `useLinkedState(source, calculate)` that keeps the value editable while
`source` is unchanged and recalculates it in the same render when `source` changes, with no
effect and no extra render." evidence: "The written state has writes both in this effect and in
a handler (`component_state.state[].writes` with `within: handler`), and the effect's dependency
is the source the value follows." contrast: "Not `render_computation`: the value stays editable
between source changes, so it cannot be a pure derivation. Not `key_prop`: only one slice of
state follows the source; the rest of the component's state must survive."

**key_prop** — description: "Delete it. It resets most or all of the component's state when an
identity prop changes, which React does natively by remounting — pass `key={thatProp}` where the
component is rendered." evidence: "Several `state-setter` calls whose arguments are constants or
the states' initial values, all keyed on one id-like dependency." contrast: "Not
`use_linked_state`: that adjusts one slice while the rest persists; this wipes the lot. Not
`render_computation`: nothing is computed, state is being cleared."

**event_handler** — description: "Delete it. The work belongs in the event handler that causes
it: a user interaction set a flag or a value, the effect noticed, and the handler could have
done the work directly — a POST, a notification, a navigation." evidence: "The dependency is
state written only within a handler, often tested for truthiness at the top of the effect; the
body performs a side effect rather than setting more state." contrast: "Not
`collapse_to_handler`: this effect performs an external action, not another state update. Not
`notify_parent`: the callee is not a callback prop."

**collapse_to_handler** — description: "Delete it. It is one link in a chain where a state
update triggers an effect that performs another state update. Compute the whole next state in
the handler that starts the chain — one transaction, no cascading renders." evidence: "The
body's calls are all `state-setter`s, its dependency is itself state, and that state is written
in a handler or another effect." contrast: "Not `event_handler`: the body sets state rather than
performing an external action. Not `render_computation`: the written state is a transition
(increment, toggle, reset-and-advance), not a pure function of the dependency."

**notify_parent** — description: "Delete it. It calls a callback prop to tell the parent that
local state changed. Call the callback in the same handler that sets the state, with the next
value, and remove the round trip through render." evidence: "A `prop-callback` call in
`effect_body.calls` whose `inputs` are local state, with that state also written within a
handler." contrast: "Not `event_handler`: the callee is a parent-supplied callback, not an
external side effect. Not `lift_fetch`: what goes up is user state, not fetched data."

**lift_fetch** — description: "Delete it and move the data fetching to the parent. The child
fetches, or receives query data, and passes it up through a callback prop — data flowing back up
instead of down." evidence: "A `prop-callback` call whose argument is the result of a query hook
(`hookResults` in `component_state`) or of a fetch in this body." contrast: "Not `notify_parent`:
what goes up is server data, not user state. Not `data_library`: the fetch may already use a
library hook; the problem is the direction of flow."

**data_library** — description: "Replace the effect and the state it fills with a data-fetching
hook — Apollo's `useQuery` or a generated per-operation `useXQuery` hook, React Query, SWR. It
fetches on mount and when an id changes, and the library handles cancellation, races, dedup and
caching." evidence: "A call to `fetch`, an HTTP client, `client.query`, or a `.then` that ends in
a `state-setter`; dependencies that are ids or query variables." contrast: "Not `lift_fetch`: the
data is consumed here, not passed up. Not `keep_effect`: a network read that fills state is
exactly what the library hook exists for."

**external_store** — description: "Replace the state and the effect with `useSyncExternalStore`.
The effect subscribes to a browser API or third-party store only to mirror its *current value*
into React state." evidence: "`addEventListener`, `subscribe`, `.on(`, `matchMedia` or an
observer in `effect_body`, a `state-setter` called `nested` inside the listener with the source's
current value, and a cleanup that unsubscribes." contrast: "Not `keep_effect`: the effect exists
only to copy an external value into state, which the store hook does without tearing; an effect
that accumulates events (appending messages, counting ticks) is not a snapshot and stays
`keep_effect`. Not `data_library`: the source is a live subscription, not a request."

**module_init** — description: "Move it out of React. It performs one-time application
initialisation — auth from storage, SDK setup, global configuration — that should run once per
page load, not once per mount and twice under StrictMode. Module scope, or a module-level guard
flag." evidence: "Empty dependencies, no cleanup, and calls that touch global singletons rather
than anything from props, state or this instance." contrast: "Not `mount_effect`: initialisation
has nothing to do with this instance being on screen and nothing to tear down; a mount effect is
per instance."

**mount_effect** — description: "Keep it but wrap it in a named mount-only hook of the shape
`useMountEffect(effect)`. It genuinely synchronises with an external system once when this
instance mounts, has empty dependencies by design, and usually returns a cleanup." evidence:
"`depsKind: empty`, a cleanup, and externals or resolved callees that set up a widget, observer,
listener or connection for this instance." contrast: "Not `keep_effect`: the dependency array is
empty on purpose; nothing should re-run it. Not `module_init`: it is per instance and has a teardown."

**effect_event** — description: "Keep the effect but extract the reads that should not re-trigger
it into a stable event function that always sees the latest values (`useEffectEvent`). The effect
correctly synchronises on one dependency yet lists — or must list, per the lint — another value it
only reads, so it re-runs for no reason." evidence: "Two or more dependencies where one is the
trigger and another is only read inside the body; often an `eslint-disable` comment or a ref used
to smuggle the latest value." contrast: "Not `keep_effect`: that has no over-reactive dependency.
Not `event_handler`: the effect is still needed; only a read moves out of it."

### The two questions

```ts
const questions = {
  effect_is_justified: noul(
    "Is the effect in `effect_call` a genuine synchronisation with a system outside React that has to happen because this component is on screen? Judge from what `effect_body` actually calls and touches, from `component_state`, and from `component_source`.",
    {
      true: "It sets up, drives or tears down something React does not own — a connection or subscription that accumulates events, an imperative library or DOM handle, focus or scroll, analytics, a timer that produces new information — and no library hook already covers that job",
      false: "Everything it does could be expressed without it: it writes state computable from props or state, it reacts to a user action a handler could perform, it resets state a key would reset, it notifies a parent, it fetches data a data-fetching hook would fetch, or it mirrors the current value of an external source into state, which useSyncExternalStore already covers",
    },
  ),
  replacement: choice(
    "What should happen to the effect in `effect_call`? Pick the single best-fitting outcome, using `effect_body` for what it calls, `component_state` for which state it writes and where else that state is written, and `component_source` for the whole picture. Each option's `contrast` names the neighbour it is not.",
    REPLACEMENTS,
  ),
}
```

Tests must always script the choice — the mock judge's default is `labels[0]` = `keep_effect`,
which `decide` suppresses, so an unscripted e2e test would pass silently.

Wire cost estimate: ~1,100 tokens of questions per request on top of state. 272 effects ~ 400k
input tokens ~ $0.02 for the whole target repo.

## 5. `decide`

```ts
export const JUSTIFIED_MAX = 0.4          // GUESS — memo rule's asymmetry by analogy; case 1 decides
export const JUSTIFIED_CAVEAT_MIN = 0.2   // GUESS — mirrors IDENTITY_CAVEAT_MIN
export const MOUNT_JUSTIFIED_MIN = 0.7    // GUESS — positive claim needs strong evidence; case 13
export const EITHER_OR_MIN = 0.25         // GUESS — no memo analogue; case 4

export const KEEP_FAMILY: ReadonlySet<Replacement> = new Set(["keep_effect", "mount_effect", "effect_event"])

export function choiceMode(p: Readonly<Record<string, number>>, fallback: string):
  { mode: string; mass: number; runnerUp: string | null; runnerUpMass: number }
```

Which thresholds follow from measurement: **none directly.** Every one must be checked live
before the rule is trusted.

Steps:

1. `justified = answers.effect_is_justified.noul`; read `effect_call` and `effect_body` from slices.
2. **Keep branch** — if `justified > JUSTIFIED_MAX`:
   - if `justified >= MOUNT_JUSTIFIED_MIN` **and** `depsKind === "empty"` -> return
     `{ messageId: "wrapMountEffect", ... }`. The Choice is not consulted; the static `[]` is the
     whole condition. If `readsOutsideDeps` is non-empty, the message adds the `key` clause.
   - else return null. (`effect_event` lives here and is unreachable by design this iteration.)
3. **Delete branch** — `{ mode, mass, runnerUp, runnerUpMass } = choiceMode(...)`.
   - if `KEEP_FAMILY.has(mode)` -> return null (disagreement; not one-sided).
   - No confidence gate on the Choice — low confidence between two delete-family outcomes is
     still certainty that the effect should go.
4. Compute the static facts.
5. Either/or: if `runnerUp !== null && runnerUpMass >= EITHER_OR_MIN`: if `KEEP_FAMILY.has(runnerUp)`
   it becomes a caveat ("model gave N% to keeping it"), otherwise the message carries both fixes.
6. Return `{ messageId: "replaceEffect", message: buildMessage(facts), facts }`.

```ts
export type EffectFacts = {
  owner: string; ownerKind: "component" | "hook" | "other"
  depsKind: DepsKind; deps: string[]; hasCleanup: boolean
  justified: number
  replacement: Replacement; replacementMass: number
  runnerUp: Replacement | null; runnerUpMass: number
  choiceConfidence: number
  probabilities: Record<string, number>   // carried for ablation
  settersCalled: string[]; setterInputs: string[]; propCallbacksCalled: string[]
  externals: string[]; unresolvedCallees: string[]; readsOutsideDeps: string[]
}
```

## 6. Message

Shape: `useEffect should not exist — <what it does, from static facts>; <fix>[; alternative][; caveats]`.
The observation clause is built from `effect_body`, never from the model, so it is always true of
the code: "sets `filtered` from `products`" / "calls `onChange(isOn)`" / "calls `fetchProduct` and
sets `product`" / "touches `window.addEventListener` and sets `isOnline`".

Fix phrases keyed to the Choice labels (update together, like `COST_PHRASE`):

| label | fix phrase |
| --- | --- |
| render_computation | compute it during render and delete the state and the effect |
| use_memo | compute it during render inside `useMemo` and delete the state and the effect |
| use_linked_state | replace the state and the effect with `useLinkedState(<dep>, () => <initial>)` (project hook; edits persist until `<dep>` changes, then it resets in the same render) |
| key_prop | delete it and render this `<owner>` with `key={<dep>}` so React remounts it |
| event_handler | do that work in the handler that sets `<dep>` and delete the flag state and the effect |
| collapse_to_handler | compute the whole next state in the handler that sets `<dep>` and delete the effect |
| notify_parent | call `<callback>(next)` in the handler that sets `<state>` and delete the effect |
| lift_fetch | move the query to the parent and pass the data down as a prop instead of up through `<callback>` |
| data_library | replace the effect and the `<state>` state with the project's data-fetching hook for this request |
| external_store | replace the `<state>` state and the effect with `useSyncExternalStore(subscribe, getSnapshot)` over `<external>` |
| module_init | move it to module scope, or guard it with a module-level flag, so it runs once per page load rather than per mount |

`wrapMountEffect`: "useEffect with [] is a mount-only sync with <externals> — wrap it in the
project's `useMountEffect` so the intent is explicit and the lint suppression lives in one
place[; it also reads `roomId`, so pass `key={roomId}` at the call site if that should restart it]".

The render/memo either-or is special-cased into one clause; any other pair appends
"; or (<N>%) <fixB>".

Caveats — only these:
- `unresolvedCallees.length > 0`: "N callee(s) (a, b) unresolved across files — verify what they do before removing"
- callback is an unresolved identifier: "the effect body is `syncTitle`, defined elsewhere — verify before removing"
- `JUSTIFIED_CAVEAT_MIN < justified <= JUSTIFIED_MAX`: "weak external-sync signal (N%) — verify nothing outside React depends on this effect"
- runner-up in the keep family at `>= EITHER_OR_MIN`: "model gave N% to keeping it"

No caveat for `readsOutsideDeps` on the delete branch (ESLint's job) and no boilerplate.
Project-specific facts (hook import paths, codegen convention) go in `messageSuffix`.

## 7. Fixtures — `fixtures/useeffect-alternatives/`

| file | one line |
| --- | --- |
| `should-warn/derived-state.tsx` | Canonical: `setFiltered(products.filter(...))` on `[products]` -> `render_computation`. Backs the CLI `--dry-run` test and stylish output. |
| `should-warn/fetch-cross-file.tsx` + `_api.ts` | `fetchProduct(id).then(setProduct)` with `fetchProduct` in another module -> `data_library` with the unresolved-callee caveat. The one cross-file case. |
| `should-warn/mount-sync-empty-deps.tsx` | `new ResizeObserver` + cleanup on `[]`, Noul mocked 0.95 -> `wrapMountEffect`. Different `messageId` with the opposite gate direction; the runner path cannot be exercised in memory. |
| `should-pass/websocket-subscription.tsx` | `createConnection(roomId)` (same-file), messages appended on `on('message')`, cleanup, deps `[roomId]`; Noul mocked 0.9 -> silent. Highest-stakes case; on disk so the live test can run it. |
| `not-a-candidate/not-react-useeffect.tsx` + `_effect.ts` | `import { useEffect } from "./_effect"` -> zero candidates, zero calls. |

Everything else in memory:
- **All 14 outcomes** in one table over one in-memory candidate with hand-written `Answers`,
  asserting the fix phrase per label, that `KEEP_FAMILY` modes return null, and `facts.replacement`.
  Fourteen rows, zero files.
- Threshold table, `choiceMode` tie-break, message construction, caveat gating.
- Slice and analysis behaviour in-memory: `within` classification per context, `nested` strings,
  `externals`, `hasCleanup` for the three return shapes, `depsKind` for all four,
  `readsOutsideDeps`, ambient-vs-cross-file callee classification, `hook-result` with `via`,
  a hook-owned unit.
- e2e: the five fixtures with scripted mocks; one run of `pointless-usememo/should-pass/dep-array.tsx`
  with `ruleFilter: null` asserting **one** request with all seven slice keys and four namespaced
  questions — the batching proof.

## 8. What the rule must not do

- **`exhaustive-deps`**: `readsOutsideDeps` is a fact, phrased only inside `wrapMountEffect`'s
  `key` clause. Never "add X to the dependency array".
- **`rules-of-hooks`**: conditional or looped `useEffect` not detected.
- **Mutation during render**: `component_state.writes` may record `within: "render"`, but it is a
  description, never a finding. React Compiler lint owns it.
- **Timing**: `useLayoutEffect`/`useInsertionEffect` not candidates.
- **No `--fix`**.

## 9. Build order

1. `src/core/questions.ts` widen `ChoiceCriterion`; export; typecheck + tests green.
2. `test/helpers/run-fixture.ts` rule-scoped `ruleFilter` with `null` opt-out. Memo suite green.
3. `analysis/state-setters.ts` + in-memory tests.
4. `analysis/effects.ts` + tests; export `baseIdentifierOf` from `render-triggers.ts`.
5. Refactor `slices/callee-sources.ts` into `calleeSourcesIn`; ambient rule; memo fixtures
   unchanged (assert `cross-file-callee.tsx` still caveats).
6. `analysis/body-calls.ts` + tests.
7. Slices `component-state.ts`, `effect-call.ts`, `effect-body.ts`.
8. `rules/effect-data.ts`, `rules/useeffect-alternatives.ts`, unit tests.
9. Register in `plugins/react/index.ts` and `react.ts`; fixtures; e2e; batching test.
10. `--dry-run` over the fixtures and a slice of the target to eyeball payload sizes.
11. Live ablation; record in `CALIBRATION.md`; adjust the four thresholds; add two live tests.
12. README.

## 10. Live ablation plan

Behind `HUGAW_LIVE=1` with a `Judge` wrapper recording `(noul, choice mode, mass, runner-up)` per
candidate, since facts exist only on findings and the disagreement census needs raw answers. Whole
target repo ~$0.02, so run it all, but decide on these first:

| # | case | expected | if it fails |
| --- | --- | --- | --- |
| 1 | **WebSocket/chat room**: `createConnection(roomId)`, `on('message', ...)` appending, cleanup, `[roomId]` | Noul >= 0.7, mode `keep_effect` | **Design blocker.** Noul < 0.4 means the rule tells an agent to delete a working effect. First fix: sharpen "accumulates events vs mirrors a snapshot" in the Noul's `false` and `external_store.contrast`. If it still fails, the single Noul is the wrong gate and must become two, reported only when both agree. |
| 2 | online/offline mirror | Noul <= 0.3, mode `external_store` | Mirror clause not landing; rule goes silent on the store family. |
| 3 | `setInterval(() => setNow(new Date()), 60_000)` | Noul high | "timer that produces new information" unread; false positive on a keep. |
| 4 | `setFiltered(products.filter(...))` | Noul <= 0.2, mode `render_computation`, `use_memo` runner-up mass measured | Sets `EITHER_OR_MIN`. |
| 5 | `setSelection(null)` on `[items]` with `setSelection` also in an `onClick` | mode `use_linked_state`, `key_prop` mass measured | If `key_prop` wins, the handler-writes evidence is not enough; `component_state.writes` needs a per-state summary (`writtenIn: ["effect","handler"]`). |
| 6 | Profile reset (two setters to `''` on `[userId]`) | `key_prop` | |
| 7 | LikeButton flag | `event_handler`, `collapse_to_handler` mass measured | |
| 8 | Gold-card chain (two effects) | both `collapse_to_handler` | |
| 9 | `onChange(isOn)` on `[isOn, onChange]` | `notify_parent` | |
| 10 | child `onFetched(data)` with `data` from a `useXQuery` hook result | `lift_fetch` | Tests that `hook-result` keeps `data_library` from winning. |
| 11 | `fetchProduct(id).then(setProduct)` cross-file | Noul low, `data_library` | Checks an unresolved callee does **not** push the Noul up (CALIBRATION case C in the other direction). |
| 12 | `loadAuthFromStorage()` on `[]`, no cleanup | Noul low, `module_init` | Distinguishes from 13 purely on cleanup/per-instance evidence. |
| 13 | `ResizeObserver` on `[]` with cleanup | Noul >= 0.7, mode `mount_effect` | Sets `MOUNT_JUSTIFIED_MIN`. If Noul lands 0.4-0.7, lower the bar or accept `wrapMountEffect` rarely fires. |
| 14 | focus/blur on status change; `document.title = title` | Noul high, silent | Two everyday keeps that must not be reported. |
| 15 | the four target `useEffectEvent` sites rewritten as plain reads with both deps listed | record Noul and mode | If `effect_event` is the mode on most, build the third Noul; if not, **drop `effect_event` from the Choice** — an option never picked is pure dilution. |
| 16 | **disagreement census** over all ~270 target effects | Noul < 0.4 with keep-family mode in well under 10% | Above that, the Choice keeps effects for a reason the Noul cannot see (likely "has a cleanup"); add that to the Noul's `true`. Also count the reverse. |
| 17 | payload check | no `component_source` truncation cutting the effect out | Measure 12k truncation on large target components. |

## 11. Gotchas

- **`unitOf` inside the effect body returns the callback, not the component.** `renderTriggers`
  relies on `unitOf(declaration) !== unit` to skip nested declarations; every new "belongs to this
  unit" check must walk ancestors to the candidate unit instead of comparing the nearest function-like.
- **Slot pairing.** A component with one memo and two effects yields two requests: slot 0 batches
  memo#1 + effect#1, slot 1 is effect#2 alone. Slice names must not collide (`memo_call` vs
  `effect_call` do not), and the context citation is appended to every question when `context` is set.
- **`type` alias, not `interface`, for `Criterion`** — an interface is not assignable to core's
  index-signature `JsonObject`, and `as const satisfies` needs the literal keys for `AnswerFor`'s `keyof C`.
- **The mock judge defaults the choice to `labels[0]`** (`keep_effect`), which `decide` suppresses;
  every e2e case must script `replacement` and assert `facts.replacement`.
- **Ambient globals.** With `lib.dom`, `fetch`/`setTimeout` resolve to a `.d.ts` in another file;
  without the ambient rule every fetch fixture would caveat.
- **Effects in custom hooks** are a third of the target. `owner.kind = "hook"`, `props` are the
  hook's parameters, `prop-callback` means "hook argument", and the message says "this hook".
- **`useEffect(fn)` with no array** is a candidate (`depsKind: "none"`); a non-literal second
  argument is `"unknown"` with `deps: null`.
- **Cleanup detection** must handle `return () => ...`, `return cleanup` (identifier), and
  `() => () => ...`. An `async` callback has no cleanup and is left to the model.
- **`readsOutsideDeps` is a fact, never a finding**, and must not appear in the delete-branch message.
- **`test/cli.test.ts`** asserts exact state keys and question ids for `constant-object.tsx`; that
  file has no `useEffect`, so it is unaffected — but any new memo fixture containing an effect must
  go through `runFixture` with the default filter.
- The data-library criteria mention generated per-operation hooks generically; codegen-specific
  naming belongs in the target's `messageSuffix`, not in the rule.
