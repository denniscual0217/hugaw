# Internals

For running the thing, see [usage.md](./usage.md). This is for changing it.

```
src/core/        seams, runner, question and answer shapes, config, report
src/adapters/typescript/   ts-morph: parse, locate, resolve, units
src/plugins/react/         rules, slice extractors, static analysis
src/judge/       the TypeSafe client, the price table, the dry-run judge
src/format/      stylish, json, json-with-metadata, dry-run, external formatters
src/cli/         flags, config loading, exit code
```

## The three seams

hugaw is not a React linter. React is the first plugin. Everything language-specific enters
through one of three interfaces, all declared in `src/core/types.ts`:

| Seam | Responsibility | Today |
| --- | --- | --- |
| `LanguageAdapter` | parse files, locate nodes, find units, resolve symbols | `typescript`, via ts-morph |
| `Plugin` | bundle the rules and slice extractors for one language | `react` |
| `Rule` | `select` / `skip` / `context` / `ask` / `decide` | two React rules |

The adapter hands core an opaque type bag (`LanguageTypes`: `file`, `node`, `unit`) and a
`Program` facade over it. Core never inspects any of those values; it threads them through
and calls back into the facade for `locate`, `unitOf`, `unitKey`, `nodeType`, `textOf`. That
is what keeps ts-morph types out of `src/core` without core knowing what a ts-morph type is.

`src/core/architecture.test.ts` enforces it mechanically and recursively over `src/core/**`:
no import of `ts-morph`, `typescript`, `react`, `@typesafe-ai/sdk`, the `hugaw` self-alias, or
`../adapters/`, `../plugins/`, `../judge/`, `../cli/`, `../format/`, and no mention of a
language-specific identifier (`useMemo`, `SourceFile`, `SyntaxKind`, `TypeSafeClient`,
`JsxElement`) outside comments. Comments may name those worlds. Code may not. A hit here is a
defect, not a style note.

Two smaller consequences of the same rule:

- The adapter parses its own config keys. `configSchema` is a `looseObject`, so `tsconfig`
  survives validation untouched and reaches `adapter.parseOptions(raw)`. Core never learns
  the key's name.
- The price table lives in `src/judge/pricing.ts`, not core, because what a vendor charges is
  vendor knowledge. `src/judge/typesafe.ts` is the only file in the tree that imports the
  SDK; core's `score` / `noul` / `choice` shapes are a structural subset of the SDK's wire
  types, so questions pass through unmapped.

## The pipeline

Every rule is five functions, and the runner drives them in this order.

| step | where | costs | does |
| --- | --- | --- | --- |
| `select` | local, AST | no | yield candidate nodes |
| `skip` | local, AST | no | drop candidates that are provably fine (neither shipped rule has one) |
| slice extraction | local, AST | no, but sets the bill | build the request state |
| `ask` | local | no | return the question set |
| the judge call | network | **yes** | one request per (unit, slot) |
| `decide` | local | no | answers plus slices to a `Verdict`, or null |

Only the judge call spends anything. Slice extraction is free to run but it is what decides
how many tokens the paid step costs, so a slice that carries a field no question consults is
a pure loss. `memo_call` says exactly that in a comment, and the memo rule's
`renderTriggers` is computed in `decide` rather than shipped in a slice for the same reason.

### Batching

Batching is the runner's job, never the rule's. Rules are authored as if they ran alone.

1. Run every enabled rule's `select` and `skip` over every file. All free.
2. Group surviving candidates by **unit** (`unitKey` is `${absPath}#${startOffset}`), then by
   rule inside that unit, each rule's list sorted by location.
3. Zip the lists: slot *i* takes the *i*-th candidate of each rule. Slot count is the longest
   list.
4. Within a slot, split into **buckets** so no two rules in one request need the same
   candidate-scoped slice for different candidates. With the current rules this never splits;
   it is a guard, and the extra request ids get a `.1`, `.2` suffix.
5. For each bucket, union the slices the participating rules asked for and build the state
   once. Unit-scoped slices are cached by `unitKey`, candidate-scoped by `candidate.id`.
6. Merge every rule's `ask()` into one question map, each key namespaced
   `${ruleId}${NAMESPACE_SEPARATOR}${qid}`, where the separator is `::`. A rule whose own
   question id contains `::` is a non-fatal error.
7. Send one `JudgeRequest` with id `${unitKey}#${slot}`.
8. Demultiplex the answers by prefix and hand each rule only its own, with the prefix
   stripped. A missing answer is a non-fatal error and `decide` is not called for that rule.

Config `context` is not a slice. No plugin declares it and no rule requests it; the runner
writes it into the state under the `context` key, and `definePlugin` reserves that name so a
slice can never collide. When every contributing rule in a request has the same context text
it is written as a plain string; when they differ it becomes an object keyed by rule id, so
two rules cannot collide on a bare key. Each contributing rule's questions get
`Take \`context\` into account.` appended, because a state field nothing names tends to be
ignored. The append copies the question rather than mutating it: rules typically return a
module-level object.

Failures are contained. A throw in `select`, `skip`, a slice, `ask` or `decide` is recorded
as a non-fatal `RunError` and the run continues; only config, adapter load and glob failures
are fatal. Any error at all puts the exit code at 2 and makes `stylish` say the run was
incomplete, because an agent reading stdout must not take a partial list as the whole
picture.

`--dry-run` is not a branch in the runner. `dryRunJudge.judge()` returns `null`, which means
"declined": the request is recorded, `judged` stays false, `decide` is never called. Nothing
in core and nothing in any rule knows the flag exists. The SDK is imported lazily in
`src/cli/run.ts`, so a dry run never loads it.

## The slices

Slice extractors live in `src/plugins/react/slices/` and are registered by name in the
plugin. A name must be a plain identifier, because it appears verbatim inside question text.
`scope: "unit"` means one value per component, built once; `scope: "candidate"` means one per
call site.

`react/pointless-usememo` sends four:

| slice | scope | carries |
| --- | --- | --- |
| `component_source` | unit | the component's declaration text, truncated at 12,000 chars |
| `memo_call` | candidate | line, source, binding name, deps as written |
| `value_usages` | candidate | every reference to the binding inside the unit, with a line, a kind, a prose description and a `resolved` flag |
| `callee_sources` | candidate | `{ resolved: { name: body }, unresolved: [name] }` for functions the factory calls |

`value_usages` is where the rule's old static `skip` went. Five checks used to decide
"definitely fine" for free (memo child, dependency array, context value, comparing hook
argument, escapes the unit); they were deleted, and every fact they encoded is now a sentence
the model reads, resolved through the same predicates (`isMemoComponentTag`,
`contextValueTagOf`, `dependencyArrayHookOf`, `escapeOf`):

```
`style` passed as the `style` prop to <Row>, which is wrapped in React.memo and
compares its props by reference
`cfg` passed as the `value` prop of <ThemeContext.Provider>, so every consumer of
that context receives it
`label` returned directly from the custom hook `useLabel`, so callers outside this
file receive it
`value` assigned to `ref.current`, a member that outlives this render
`key` passed to useState(), which reads it once on mount and never compares it
across renders
```

Where a fact cannot be resolved the usage is marked `resolved: false` rather than guessed at,
and `decide` turns that into a caveat. Positional checks run against the *access chain root*
(`accessChainRoot`), so `[data.items]` is recognised as a dependency array first and a
property read second: reading a field off a memoized object inherits the memo's identity.

`react/useeffect-alternatives` sends four:

| slice | scope | carries |
| --- | --- | --- |
| `component_source` | unit | shared with the memo rule |
| `component_state` | unit | `owner` (name and `component`/`hook`/`other`), `props`, every `useState`/`useReducer` pair with its initial value and **every write site classified by the kind of function it sits in**, and `hookResults` |
| `effect_call` | candidate | line range, source, deps, `depsKind`, `hasCleanup`, callback shape, `readsOutsideDeps` |
| `effect_body` | candidate | every call classified by origin, plus `resolved` / `unresolved` callee bodies and `externals` |

Three fields carry most of the discriminating power:

- `state[].writes[].within` is `render`, `effect`, `handler`, `callback` or `other`. "The
  handler could have done this directly" is evidence rather than a guess only because the
  handler write is in the payload. It is also what separates *editable* state that follows a
  prop from state an effect merely clears.
- `hookResults` pairs each binding with the hook that produced it, so `const { data } =
  useGetProductQuery()` can be told from `const [data] = useToggle()`. A bare list of names
  cannot make that distinction, and it is the difference between "the child is bubbling
  fetched data up" and "the child is telling its parent about a toggle".
- `calls[].nested` says where inside the effect a call sits. `setNow()` in the body is derived
  state; the same call inside a `setInterval` callback is a subscription.

`depsKind` has four values rather than a nullable list because the *absence* of the array and
an array that cannot be read are different facts: `useEffect(fn)` re-runs every render, which
no option in the Choice describes, while `useEffect(fn, computed)` is an effect whose
reactivity is simply invisible.

`readsOutsideDeps` is a fact and never a finding. It surfaces at most as a `key={…}`
suggestion on a mount finding, never as "add it to the dependency array"; `exhaustive-deps`
owns that.

### `callee_sources`, and why it is the accuracy

`calleeSourcesIn` walks the factory (or the effect callback) and, for every call, inlines the
callee's body when it can. Calibration cases B and D are the proof it earns its tokens:
identical call shapes, `buildPivot(rows)` and `countRows(rows)`, scoring 2.00 and 0.11,
decided purely by the body that was inlined.

The exact rule it applies, because the caveats and the limits both follow from it:

- **Bare identifiers only.** `obj.method()` is skipped, silently. The callee belongs to a
  value, not to a module.
- **Same file only.** A declaration in another file goes to `unresolved`. There is no digest
  pass.
- **A function body, or nothing.** A `FunctionDeclaration`, or a binding whose initializer is
  a function or arrow. A parameter, a destructured prop, or a binding initialized to anything
  else goes to `unresolved`, because recording the *name* as though it were the body tells
  the model that `transform` does whatever "transform" sounds like.
- **Ambient declarations are skipped entirely**, neither resolved nor unresolved. `fetch`,
  `setTimeout` and `parseInt` resolve into a `.d.ts` in another file; caveating on them would
  fire on most findings in any project with `lib.dom`, and a caveat naming a global everyone
  can see is the kind of noise that teaches a reader to skip the caveat line. They are also
  the one case where the name alone is a reliable description.
- **One level.** The bodies that get inlined are not themselves walked.

`bodyCalls` reuses the same walk, then subtracts the names `effect_body.calls` already
explains by origin (state setters, callback props, hook results) from `unresolved`: telling
an agent to go find out what `setFiltered` does across files is both false and noise.

## `decide`

### `react/pointless-usememo`

Two questions, `cost` (a four-level Score) and `identity_matters` (a Noul). Gates, in the
order they run:

```ts
const IDENTITY_MATTERS_MAX   = 0.4
const UNBOUNDED_WORK_MASS_MIN = 0.5
const COST_MAX               = 1.2
const MIN_CONFIDENCE         = 0.6
const IDENTITY_CAVEAT_MIN    = 0.2   // caveat band, not a gate
```

1. `identity_matters > 0.4` → silent. Measured: the six-case run puts a context value at 0.85
   and every genuinely pointless memo between 0.08 and 0.12. After the `skip` deletion, all
   twelve former skip cases plus five probes were re-measured and land between 0.45 and 0.97.
   `should-pass/shadowed-hook.tsx` sits at 0.45 against the 0.4 gate and is pinned at its
   measured value in the test, so drift is visible rather than silent.
2. `unboundedWorkMass > 0.5` → silent. This is `1 - P(level 0) - P(level 1)`: probability
   mass on the two levels that mean "a collection whose size is not bounded here". Mass, not
   expected score, and that is the point. An expected score of 1.0 can mean "confidently one
   pass over a bounded literal" or "evenly split between constant work and an unbounded
   pass", and only the second is work worth skipping. Thresholding the score instead would
   put the decision three hundredths from a measured bounded literal at ~0.97, which is a coin
   flip waiting for a model update, failing by dropping a true positive.
3. `cost.score > 1.2` → silent. From the six-case run: 0.00, 0.11 warn; 2.00 silent.
4. `cost.confidence < 0.6` → silent. Measured confidence ran 0.89 to 1.00, so this gate
   almost never fires. It is kept as cheap insurance and is explicitly *not* expected to be
   load-bearing.

The asymmetry is deliberate: weak evidence of legitimacy suppresses, strong evidence of
pointlessness reports. The burden of proof is on the linter.

`IDENTITY_CAVEAT_MIN = 0.2` is the bottom of the band that earns the "weak identity signal"
caveat. The calibration has no row for it; it changes the wording of a finding already
decided, never whether one is made.

`rendersWithUnchangedDeps` is computed and **not** gated on. `dependencyCoverage` collects
the unit's reactive inputs (props, `useState`/`useReducer` values, `useContext` results, and
any other hook's result, with setters excluded as stable and `useRef`/`useMemo`/`useCallback`
excluded as derived) and asks whether the dep array is a *proper* subset. A gate over it was
written and deleted: it needed a threshold no ablation supports, and small work skipped often
is still only small work saved. The fact is carried into `facts` so the ablation that would
justify it is cheap to run later. When the deps cover every input exactly, whether the memo
pays off depends on callers re-rendering with stable props, which is the same cross-file
problem as `React.memo` and out of scope.

### `react/useeffect-alternatives`

One question: a Choice over what should happen to the effect, one label per outcome.
`REPLACEMENTS` in `effect-questions.ts` is the list, and it grows. Three labels keep the
effect (`keep_effect`, `mount_effect`, `effect_event`, the `KEEP_FAMILY` set); every other
label deletes it.

```ts
export const KEEP_FAMILY_MASS_MAX = 0.5
export const EITHER_OR_MIN        = 0.1
```

`decide`:

1. Mode is `mount_effect` **and** keep-family mass > 0.5 → the `wrapMountEffect` finding.
2. Keep-family mass > 0.5 → silent.
3. Mode is in the keep family but the mass is not → silent. Belt and braces: a keep-family
   mode under half the mass is a distribution nobody has measured, and this rule deletes code.
4. Otherwise the `replaceEffect` finding, with the mode choosing the fix phrase.

`KEEP_FAMILY_MASS_MAX = 0.5` is measured, and it is the reason a second question was deleted
rather than tuned: effects that must be deleted land in one band, effects that must be kept
land in another, and nothing lands between them. The bands move by a few hundredths run to
run and by more than that whenever an option is added to the Choice, so the numbers live in
one place — [Calibration](#calibration) — rather than being restated here.

Summing the family rather than reading the mode is the whole mechanism. A distribution like
`{keep .30, effect_event .12, mount .05, render .31, memo .22}` has a delete-family mode and
47% of its belief on leaving the effect alone.

`wrapMountEffect` requires the mode and not only the mass, and that requirement carries
weight: SKILL.md's canonical `useSyncExternalStore` example has empty deps, a cleanup and
listeners, which is `mount_effect`'s stated evidence verbatim. Measured ([Calibration](#calibration)
case 2), it puts nearly all its mass on `external_store` and next to none on `mount_effect`.
Gating on the evidence rather than on the model's own choice would tell a reader to do the
opposite of the right thing.

`EITHER_OR_MIN = 0.1` is the bar for printing the runner-up as an alternative fix. It fires
only for a delete-family runner-up; a keep-family runner-up becomes a caveat instead. The
plan's guessed 0.25 would have fired twice in seventeen, both times on a keep-family
runner-up, which is to say never where a second fix is what the reader needs.

There is no confidence gate. `choice.confidence` is carried in `facts` so it can be ablated
later; low confidence *between two delete outcomes* is still certainty that the effect should
go.

## Two rules of method

**Thresholds come from live ablations, not from judgment.** Every constant in
`src/plugins/react/rules/**` should be traceable to a row in [Calibration](#calibration) below, and where it is
not, the rule file says so in a comment. The memo rule's four gates come from a six-case run
made *before* the rule was implemented; the effect rule's two come from a seventeen-case run
made before `decide` existed, which changed the rule's shape (one question instead of two)
rather than confirming it; that run has since grown to twenty-three cases as options were
added. Repeated runs across several payload and criteria revisions gave the same mode on
every case, so the numbers are reproducible rather than a single sample. The discipline is visible in what is missing: a second, lower cost threshold for the
case where `rendersWithUnchangedDeps` holds was written and then deleted, because no live
ablation supported the number it needed, and a hand-picked constant that only ever suppresses
is still an unmeasured decision to drop findings. The signal is computed and carried into
`facts` precisely so that the ablation which would justify the gate is cheap to run later. If
you add a threshold, measure it first and add the row.

**A criterion may only ask what the payload can answer.** The memo rule's cost rubric
originally had a level reading "work over a collection that is typically small: one map,
filter, or find". Nothing in the payload says how large a collection is at runtime, so
`items.filter(...)` over a prop array of thousands matched those words correctly and produced
a confident false positive on load-bearing production code, at 0.90 confidence. The fix was
not more context; it was a rubric that splits on whether the size is *bounded and visible in
the code we sent*: an inline literal or a tuple on one side, a prop or state array that could
hold thousands on the other. Ablated live, the same filter moved from 1.10/0.90 (reported) to
2.01/0.98 (silent), suppressed for being expensive rather than for being unclear. Adding type
information to the old rubric only reached 1.41/0.59, which is suppression by doubt, and doubt
is not a mechanism to rely on. Before you write a criterion that names a fact, check that some
slice carries that fact.

## Calibration

The evidence behind every threshold in `src/plugins/react/rules/**`. Both rules were ablated
against `jev-1.13.0` *before* they were implemented, and in the effect rule's case the run
changed the design rather than confirming it.

Reproduce the effect rule's run with:

```sh
HUGAW_LIVE=1 npx vitest run test/effect-ablation.live.test.ts
```

That file is the ablation: the cases, the two rejected question wordings, and an assertion
that the gate still separates the two families. Sources are synthetic — the repository this
was designed against is an employer's codebase and was never sent to the API.

### `react/pointless-usememo`

> **Stale as of 2026-09-21.** Measured against the pre-2026-09-21 cost rubric; the verdicts
> still hold, but the `cost` column predates the bounded/unbounded criteria. Do not re-derive
> thresholds from these numbers.

Six cases, run before implementation, 6/6 correct. Thresholds under test:
`identity_matters > 0.4` → silent · `cost > 1.2` → silent · `confidence < 0.6` → silent.

| case | scenario | cost | conf | identity | verdict | correct |
|---|---|---:|---:|---:|---|---|
| A | `` `${currency}${amount.toFixed(2)}` `` rendered in `<span>` | 0.00 | 1.00 | 0.08 | **WARN** | ✓ |
| B | `buildPivot(rows)`, callee source inlined (nested loops) | 2.00 | 1.00 | 0.10 | silent (cost) | ✓ |
| C | `buildPivot(rows)`, callee **unresolved** (cross-file) | 2.00 | 0.99 | 0.11 | silent (cost) | ✓ |
| D | `countRows(rows)`, callee source inlined (`rows.length`) | 0.11 | 0.89 | 0.08 | **WARN** | ✓ |
| E | `[...users].sort(...)` iterated in render | 2.00 | 1.00 | 0.12 | silent (cost) | ✓ |
| F | `({theme, locale})` passed as context `value` | 0.00 | 1.00 | 0.85 | silent (identity) | ✓ |

3,634 input tokens for all six = **$0.000153**.

**B versus D is the proof `callee_sources` earns its keep.** Identical call shape, opposite
verdict — 2.00 against 0.11 — decided purely by the inlined callee body. Both are fixtures
for that reason.

**C got the right answer for a possibly wrong reason.** With the body unresolved the model
inferred expense from the *name* `buildPivot`. Correct here, but name-based inference is not
reliable: a cross-file `formatLabel` would likely read as cheap and could produce a false
warning. That is why `unresolved` drives a caveat instead of a suppression, and why C is not
evidence that a digest pass is unnecessary.

**Confidence ran 0.89–1.00**, so `MIN_CONFIDENCE = 0.6` almost never fires. It is kept as
cheap insurance, not as a load-bearing gate.

**F is caught twice** — once by `identity_matters` at 0.85, and once by the `skip` that
existed at the time. That `skip` has since been deleted; the model alone now holds that case,
which is the direction the project moved in generally.

### `react/useeffect-alternatives`

Twenty-three cases. The original sixteen came from the plan; 17 is a control added when 12
turned out to be confounded; 18–21 were added with the `ref_callback` option; 22–23 are the
two links of one state chain.

`keepFam` is the summed mass of `keep_effect + mount_effect + effect_event` — the gate.
`noul¹` and `noul²` are two wordings of a **second question that was measured and deleted**;
they survive in the ablation file so this table can be re-derived, and nowhere else.

| # | case | mode | mass | keepFam | runner-up | noul¹ | noul² |
|---|---|---|---:|---:|---|---:|---:|
| 1 | websocket chat room | `keep_effect` | 0.99 | **0.99** | external_store 0.01 | 0.48 | 0.93 |
| 2 | online/offline mirror | `external_store` | 0.98 | **0.02** | mount_effect 0.02 | 0.29 | 0.65 |
| 3 | setInterval clock | `mount_effect` | 0.50 | **0.93** | keep_effect 0.43 | 0.40 | 0.84 |
| 4 | derived state | `render_computation` | 1.00 | **0.00** | — | 0.10 | 0.02 |
| 5 | selection reset on `[items]` | `derive_by_id` | 0.92 | **0.00** | key_prop 0.07 | 0.12 | 0.02 |
| 6 | profile reset on `[userId]` | `key_prop` | 0.99 | **0.00** | derive_by_id 0.01 | 0.13 | 0.03 |
| 7 | LikeButton flag | `event_handler` | 1.00 | **0.00** | — | 0.14 | 0.10 |
| 8 | notify parent of a toggle | `notify_parent` | 1.00 | **0.00** | — | 0.13 | 0.06 |
| 9 | child bubbles query data up | `lift_fetch` | 0.89 | **0.10** | effect_event 0.08 | 0.20 | 0.06 |
| 10 | fetch on id change, callee cross-file | `data_library` | 0.96 | **0.04** | keep_effect 0.04 | 0.18 | 0.13 |
| 11 | auth from storage on `[]` | `module_init` | 0.99 | **0.01** | mount_effect 0.01 | 0.14 | 0.27 |
| 12 | ResizeObserver on `[]`, writes width to state | `external_store` | 0.65 | **0.35** | mount_effect 0.31 | 0.50 | 0.86 |
| 13 | `document.title` on `[title]` | `keep_effect` | 0.97 | **0.97** | render_computation 0.03 | 0.18 | 0.40 |
| 14 | effect inside a custom hook | `notify_parent` | 0.93 | **0.05** | keep_effect 0.03 | 0.16 | 0.06 |
| 15 | no dependency array at all | `keep_effect` | 0.97 | **1.00** | mount_effect 0.03 | 0.24 | 0.80 |
| 16 | `async` callback with `.then(setX)` | `data_library` | 0.96 | **0.04** | keep_effect 0.04 | 0.18 | 0.13 |
| 17 | third-party widget on `[]` *(control for 12)* | `mount_effect` | 0.72 | **0.97** | keep_effect 0.24 | 0.46 | 0.92 |
| 18 | focus a conditionally rendered input | `ref_callback` | 0.98 | **0.02** | keep_effect 0.02 | 0.26 | 0.85 |
| 19 | focus an always-mounted input | `keep_effect` | 0.85 | **0.85** | ref_callback 0.14 | 0.23 | 0.79 |
| 20 | scroll a conditionally rendered node into view | `ref_callback` | 0.75 | **0.25** | keep_effect 0.25 | 0.23 | 0.78 |
| 21 | measure a node on mount, store the width | `keep_effect` | 0.69 | **0.73** | ref_callback 0.15 | 0.21 | 0.38 |
| 22 | cascading state, first link (`count` → `isTen`) | `render_computation` | 0.53 | **0.01** | collapse_to_handler 0.46 | 0.13 | 0.02 |
| 23 | cascading state, second link (`isTen` → `message`) | `collapse_to_handler` | 0.58 | **0.01** | render_computation 0.41 | 0.12 | 0.02 |

About 4,770 input tokens per case, 109,813 for the run: **$0.0046**.

### The gate, as a band

`KEEP_FAMILY_MASS_MAX = 0.5`. Sorted, the keep-family mass across all 23 cases:

```
must be deleted (16)   0.00 ×5   0.01 ×3   0.02 ×2   0.04 ×2   0.05   0.10   0.25   0.35
must be kept     (7)   0.73   0.85   0.93   0.97 ×2   0.99   1.00
```

**Deletes at or under 0.35, keeps at or above 0.73**, with nothing in between. Read these as
bands, not as points: they move by a few hundredths run to run, and they move more than that
whenever an option is added to the Choice. The two narrowest keeps are the newest cases — 19
at 0.85 and 21 at 0.73 — and without those the keep band starts at 0.93.

**Case 12 occupies 0.32–0.35 across four runs.** It is the narrowest clearance in the table
and the one to re-measure first whenever the option list changes. Its history is the reason:
it read 0.17 before `use_linked_state` was added, then 0.32–0.35 after. Adding an option
redistributes mass everywhere and it lands hardest where the model was least certain to begin
with.

`EITHER_OR_MIN = 0.10` decides when the runner-up's fix prints as an alternative. The largest
runner-up in the table is `collapse_to_handler` at 0.46 on case 22 — the genuine near-tie the
threshold exists for, a chain whose first link is also a plain derivation. The next are 0.25
(case 12) and 0.24 (case 17). The plan's guessed 0.25 would have fired on one case in
twenty-three.

There are no other thresholds for this rule.

### Why the second question was deleted

This is the clearest illustration in the project of measuring before building.

The plan gated on a Noul asking whether the effect was a genuine synchronisation with an
external system. Two wordings were measured — `noul¹` restructured both sides around a single
axis, `noul²` was the plan's enumerating original — and **neither can gate**:

| signal | effects that must go | effects that must stay |
|---|---|---|
| keep-family mass | ≤ 0.17 | ≥ 0.92 |
| `noul¹` | 0.10 – 0.47 | 0.16 – 0.48 |
| `noul²` | 0.03 – 0.87 | 0.41 – 0.93 |

Both overlap. Under `noul¹`, `document.title` — an effect that must stay — scored 0.16,
*below* the online/offline mirror at 0.26, which must go. Under `noul²` that same mirror
scored 0.63, high enough to suppress the very finding it exists to produce.

The Choice had been carrying the signal the whole time, and reading only its mode threw it
away. Deleting the question removed roughly half the question tokens, three of the four
guessed constants (`JUSTIFIED_MAX`, `JUSTIFIED_CAVEAT_MIN`, `MOUNT_JUSTIFIED_MIN`), and the
question of what to do when two questions disagree.

One prediction did not survive contact with the numbers: the concern that a checklist-shaped
Noul would make `module_init` unreachable. Case 11 scores 0.29 under `noul²`, already on the
unjustified side of any sane threshold.

### The `use_linked_state` split

Editable state seeded from a prop:

```tsx
const [name, setName] = useState("")
useEffect(() => { setName(user.name) }, [user.id])
return <input value={name} onChange={(e) => setName(e.target.value)} />
```

This measured `derive_by_id` 0.56 / `render_computation` 0.27. **Both are breaking advice** —
`name` is editable, and computing or deriving it during render deletes the user's ability to
type. The option that fits was not on the menu at all, having been dropped earlier in favour
of `derive_by_id` on the evidence of two cases that are not editable in this way.

**The handler write does not separate the two.** This case and case 5 have identical `writes`
shapes, an `effect` entry and a `handler` entry:

```
this case   [["effect", "user.name"], ["handler", "e.target.value"]]
case 5      [["effect", "null"],      ["handler", "i"]]
```

What separates them is the **argument of the effect's write**: one seeds the state *from the
source*, the other *clears* it to a constant. A choice can be kept as an id and looked up
again; free-typed text cannot be reconstructed from any id. Each criterion now names that
fact from its own side.

| | before | after |
|---|---|---|
| the editable case | `derive_by_id` 0.56, `render_computation` 0.27, `use_linked_state` **absent** | `use_linked_state` **0.99** |
| case 5 | `derive_by_id` 0.89, `key_prop` 0.11 | `derive_by_id` **0.92**, `key_prop` 0.07 |
| case 6 | `key_prop` 0.99, `derive_by_id` 0.01 | `key_prop` 0.99, `derive_by_id` 0.01 |

Case 5 got *sharper* rather than degrading, which was the check that mattered: the neighbour
whose mass the new option was most likely to take instead improved.

### Case 12 is not a miss

A `ResizeObserver` on empty deps that writes the measured width into state comes back
`external_store`, and the rule reports it. **That is the right answer.** An effect whose whole
job is to mirror an external value into React state is what `useSyncExternalStore` is for, and
being set up on mount does not change that. The case cannot set a mount threshold because the
two options are competing on merit rather than one being wrong.

Case 17 is the same shape with the confound removed — a third-party editor owned for the
instance's lifetime, no state written, nothing to mirror. It returns `mount_effect` with
keep-family mass 0.97, which is the `wrapMountEffect` finding, from the mode and the mass,
with no third threshold needed.

`should-warn/mount-sync-empty-deps.tsx` is case 17's shape for this reason. It was first
written as case 12's and measured `keep_effect` 0.52 / `mount_effect` 0.35: keep-family mass
0.97, but a `keep_effect` mode, so the rule stayed silent and a fixture in the warning bucket
reported nothing. The rule was not changed to accommodate it — the fixture was replaced with
one the model actually judges that way.

### What individual cases bought

**Case 2 is why `wrapMountEffect` requires the mode, not just the mass.** The canonical
`useSyncExternalStore` example has empty dependencies, a cleanup and listeners —
`mount_effect`'s stated evidence, verbatim — and puts 0.02 on `mount_effect`. Gating that
finding on evidence rather than on the model's own choice would tell a reader to do the
opposite of the right thing.

**Case 7 settles two criteria that overlap by construction.** `postLike(); setLiked(false)` is
an outward action *and* a state update, matching `event_handler` and `collapse_to_handler` at
once. With the contrast saying the outward action decides, it returns `event_handler` 1.00.

**Case 9 is what the hook name in `hookResults` buys.** `onFetched(data)` where `data` came
from `useGetProductQuery` returns `lift_fetch`, not `data_library`. A bare list of binding
names could not tell that `data` from a query differs from `data` from a toggle.

**Case 10: an unresolved cross-file callee does not inflate the judgment.** It sits at the
bottom of the delete band — the opposite direction to the memo rule's case C, and the reason
that blind spot earns a caveat rather than a suppression.

**Cases 14–16 were open questions.** An effect in a custom hook with no parent returns
`notify_parent`, so the instruction that "the parent" means the hook's caller lands. An effect
with no dependency array — a shape no option describes — returns `keep_effect`, so the model
declines rather than guesses. An `async` callback, where cleanup detection gives up and
reports `hasCleanup: false`, still returns `data_library`.

**Cases 18–21 are the `ref_callback` set**, and 19 is the one that matters: an always-mounted
input keyed to another prop returns `keep_effect` 0.85. A ref callback there would fire once
at mount and never again, silently dropping every later run, and the criterion has to exclude
it explicitly because it looks identical at the call site.

### The prompt bug worth remembering

When the criteria collapsed from `{description, evidence, contrast}` objects to plain strings,
the Choice's *instructions* still told the model that "each option's `contrast` names the
neighbour it is not" — pointing at a field the payload no longer had.

The collapse ablation showed zero mode changes with that sentence in place, so it looked
harmless. It was not: **case 12 read 0.44–0.50 while the prompt named a missing field, and
0.35 once it did not.** The narrowest clearance in the table was being eaten by a stale
sentence. A prompt that references a field which is not there does not fail loudly; it costs
you margin on whichever case had the least to spare.

## The message builder

The message is the product. An agent reads stdout and edits the file; nothing else ships.

The shape is fixed: `<claim>: <observation>; <fix>[; <caveat>]...`. The rules it follows:

- **Never assert more than was observed.** The observation half is built from static facts
  only, never from the model, because the fix is a judgment and is allowed to be wrong while
  the sentence describing the code an agent is about to delete has to be true of it. This is
  enforced in the small: `written()` returns `null` rather than a placeholder when no React
  state was confirmed (it once returned the literal string `"local"`, which is how a finding
  came to advise deleting "the `local` state" of a component that has no such thing), and
  `describeWritten()` degrades `render_computation`'s fix from "delete the state and the
  effect" to "delete the effect". A setter-shaped call that did not resolve is reported as the
  call it is (`calls \`setTotal(…)\` with \`items\``) and earns a caveat, never as state.
- **No probability in prose.** A number a reader cannot act on is the distribution leaking
  into their sentence. If a number would change what the reader does, it should have changed
  `decide` instead. The numbers go to `metadata.findings` in `--format json-with-metadata`.
- **No em-dashes.** One dash was doing three unrelated jobs (separating claim from
  observation, bracketing an aside, introducing a caveat's instruction), which reads as a row
  of minus signs in a monospace terminal. Claims end in a colon, asides take parentheses,
  caveats take a comma or "so". Sentences were re-read rather than swapped character for
  character, because half of them become comma splices otherwise.
- **Caveats only for real blind spots**, never boilerplate, and each names the blind spot it
  actually found. Spread usages and unclassifiable usages are counted and worded separately,
  so an agent is never sent hunting for a spread that is not there. Singular and plural follow
  the count.
- **A word budget that drops whole clauses.** `WORD_BUDGET = 35`. Findings had drifted to 58
  words where the memo rule's sit at 23. Over budget, `DROP_ORDER` removes clauses in a fixed
  order of expendability: the `useMemo` aside, then the keep-family caveat, then the
  alternative fix. Never a mid-sentence truncation, and never the fix itself or an
  unresolved-callee caveat, which names code the reader cannot see. If everything expendable
  is gone and it is still long, what remains is load-bearing and it ships long.

The aside is an *infix* parameter rather than an appended clause on purpose: dropping it has
to leave the sentence exactly as it would have been written without it. Note also that the
keep caveat and the alternative fix are mutually exclusive in practice, since both are built
from the single runner-up and it is either in the keep family or it is not.

Config `message` and `messageSuffix` are applied in `core/message.ts`, after `decide` and
outside the rule.

## Fixtures

```
fixtures/<rule name>/
  should-warn/        reaches the model and reports
  should-pass/        reaches the model and passes the gates in decide
  should-skip/        dropped before any request (only if the rule has a skip)
  not-a-candidate/    select never yields it, so nothing is requested
```

`should-pass` and `should-skip` both end in no finding, so the bucket name has to carry
*how*, not *whether*. `should-pass` was checked by the model and cleared; `should-skip` was
never checked at all, and its tests must assert the judge was invoked zero times. That
assertion is the cost model. Neither shipped rule has a `skip`, so there is no `should-skip`
directory today. `not-a-candidate` is what is left of the free bucket.

Files prefixed with `_` are support files for the fixture beside them and stay in the same
bucket, because the fixture imports them by relative path.

Keep the set small and deliberate:

- One canonical fixture per bucket. These back the CLI and end-to-end tests, which need real
  files on disk.
- A real fixture for every case where **cross-file resolution** is the thing under test: a
  memoized component behind a default export, a callee in another module. Nothing else
  reproduces it, because an in-memory source has no module graph.
- Everything else in memory, through `project.createSourceFile()` in the analysis tests or
  the rule's own test. Single-function behaviour, threshold tables and message construction
  need no file on disk, and a test that builds its own source reads better than one that
  sends you to another directory to find out what it asserts.

Roughly three fixtures, plus one per cross-file case. `pointless-usememo` predates the
convention and carries 32 across its three buckets (plus five support files); they stay
because each encodes a real regression, several added in response to a false positive on
production code, but its count is not the standard.
`useeffect-alternatives` has seven.

`test/helpers/run-fixture.ts` is scoped to one rule and takes bucket-relative paths.
Scoping matters: rules batch per unit, not per file, so a memo fixture that also contains a
`useEffect` would otherwise put two candidates in one request and make `stats.judged` count
something other than what the test is about.

`test/helpers/mock-judge.ts` synthesises answers from a script; there are no globals and no
`vi.mock`, because the runner takes its judge as a parameter.

```sh
pnpm typecheck
pnpm test        # everything mocked, zero network
pnpm build
pnpm test:live   # HUGAW_LIVE=1, one opt-in call against the real API
```

## Adding a rule

1. **Write the questions first, in their own module.** `src/plugins/<plugin>/rules/` with
   `score` / `noul` / `choice` imported from `src/core`, never from the SDK. Keeping them in
   a separate module is what lets an ablation import exactly what will ship before any rule
   is registered (`effect-questions.ts` exists for this).
2. **Measure before writing `decide`.** Build the payload, write a live ablation behind
   `HUGAW_LIVE=1` over cases whose right answer you already know, and look at the numbers
   before choosing any threshold. `test/effect-ablation.live.test.ts` is the pattern: it runs
   the slices and the questions with no rule, no `decide` and no constants. Record the table
   in [Calibration](#calibration). This is the step that changed rule two from two questions to one.
3. **Write the rule** with `defineRule`: `name` (no `/` in it, the plugin id supplies that),
   `meta` (`description`, `defaultSeverity`), `context` (the slice names it needs), `select`,
   `ask`, `decide`. Omit `skip` unless a candidate can be ruled out on syntax *alone*: a rule
   that encodes "this one is definitely fine" recreates the failure hugaw exists to avoid, and
   the one rule that had five such checks had two of them wrong in practice.
4. **Add any new slice** to the plugin's `slices` map with a `scope`. The name must be a plain
   identifier and must not be `context`, which the runner reserves; `definePlugin` throws on
   both, and it also throws if a rule declares a slice the plugin does not provide.
5. **Register the rule** in the plugin's `rules` array, and export its public types from
   `src/plugins/react/index.ts` and `src/react.ts` if consumers need them.
6. **Fixtures** under `fixtures/<rule name>/` in the buckets above.
7. Question ids must not contain `::`, and answers are validated against the question type on
   the way back, so schema drift surfaces as an error rather than as `undefined > 0.4`
   quietly passing a gate.

## Adding a replacement option to the effect rule

The Choice's labels live in `REPLACEMENTS` in `src/plugins/react/rules/effect-questions.ts`.
Each is a single string, ordered so the null hypothesis (`keep_effect`) anchors the list.

1. **Write one string, not a structured object.** Each criterion is written as three things
   (what the option means, what evidence in the payload answers it, which neighbour it is
   not), but it is *sent* as one block. The object form was measured on two cases and changed
   no answer and no probability while costing about 300 tokens a request (4,134 to 3,826 and
   4,080 to 3,772). The `ChoiceCriterion` union still admits an object; no new rule should
   reach for it without measuring that it buys something.
2. **Name the evidence from the payload**, by field. If the criterion talks about a fact, some
   slice has to carry that fact. See the second rule of method above.
3. **Write the contrast from both sides.** The option you are taking mass from needs the
   mirror clause. `use_linked_state` and `derive_by_id` split on what the effect's write *is*
   (a value seeded from the source, or a clear to a constant), and both criteria say so, from
   their own side. The shared shape of `writes` does not separate them, so the argument of the
   effect's write has to.
4. **If it keeps the effect, add it to `KEEP_FAMILY`.** That is what the gate sums. An option
   in the keep family also needs its own message path, as `mount_effect` has, or it can never
   be reported at all.
5. **Add a `FIX_PHRASE` entry.** Without one the message falls back to "replace it with the
   primitive that fits", and the option can never print as a runner-up alternative either.
6. **Re-measure all 17 cases**, and check case 12 first:

   ```sh
   HUGAW_LIVE=1 npx vitest run test/effect-ablation.live.test.ts
   ```

   Adding an option redistributes mass everywhere, and it lands hardest where the model was
   least certain. Case 12 is the documented ambiguous one; its keep-family mass went from 0.17
   to 0.32 when the fourteenth option landed, halving its clearance below the gate from 0.33
   to 0.18. Nothing crossed and no mode changed, but that is the number to watch. Update
   the [Calibration](#calibration) section with the new table.
7. Confirm a fixture in `should-warn` still measures the way its bucket claims. A fixture in
   the warning bucket that the live model is silent on is exactly the mislabelling the buckets
   exist to prevent, and the fix is to replace the fixture, not to relax the rule.

## Known limits

**Callee resolution.** Same file only, one level deep, bare identifiers only. `obj.method()`
is skipped silently and contributes nothing, not even a caveat. A callee bound to a prop, a
parameter, or a cross-file import goes into `unresolved` and drives a caveat, because
recording a name as though it were a body invites a confident judgment about code the model
has never seen. Calibration case C is the warning: with the body unresolved, the model
inferred expense from the *name* `buildPivot` and happened to be right. A cross-file
`formatLabel` that actually regexes an i18n bundle reads cheap at 0.08 and warns, which is
the same failure with the sign flipped.

**What the digest pass would fix.** A second, cheap Jev call per unresolved callee,
summarising what it does, so the cost question and the Choice see behaviour instead of a
name. It would remove the caveat for that case, make `unresolved` rare, and retire the
`context` workaround as the manual fix for cross-file callees. `resolve.digestDepth` is typed
in the config and unused; SPEC §7 has the scope. Note that cross-file resolution *does*
already work for other purposes: `isMemoComponentTag` follows `export default memo(Child)`
through a default import, and `importSourceOf` resolves React's own exports across files.
What is missing is specifically the inlining of a cross-file callee's body.

Other limits, each with its reason:

- **Aliases are not followed** in `escapeOf`: `const out = value; return out` is not seen as
  an escape. Tracking assignment graphs is out of scope; the model still sees the `returned`
  usage on the alias.
- **`renderTriggers` over-counts.** Any unrecognised `useX()` result counts as a reactive
  input, so `useNavigate` and `useId` widen the input set and can suppress a finding. That is
  the burden-of-proof direction; narrowing it to an allowlist would lose the `useQuery`-shaped
  cases it exists for.
- **Handler detection is by naming convention** (`handleX`, `onX`, an `on*` JSX attribute, a
  `useCallback` bound to such a name). A miss only moves a write from `handler` to `callback`,
  which the model reads as weaker evidence rather than as a wrong fact.
- **The cache is a no-op.** `Cache` is a real interface with `noopCache` behind it and the
  runner already consults it (including not charging a cache hit to the token count), so
  filling it in touches one file.
- **`limits.maxRequests`, `resolve.digestDepth`, `resolve.knownHooks`** are typed, validated
  and unused.
- **`React.memo` pointlessness** needs a reverse index from every JSX call site and is not in
  scope.
- **`assertJson` is not called at the slice boundary**, despite its doc comment; today it only
  runs in a test over the Choice's criteria. A slice returning a non-serialisable value would
  fail later, at `JSON.stringify`, rather than at the boundary with a path.
