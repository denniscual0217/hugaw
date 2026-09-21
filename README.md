# hugaw

`hugaw` is Cebuano for *dirt*. Code that violates a rule is dirt that needs cleaning.

A **context-aware linter**. Where ESLint and oxc decide from the AST alone, hugaw sends a
bounded slice of *resolved* context to a small calibrated judgment model (TypeSafe Jev) and
decides from a probability. It exists to catch defects that are **semantic, not syntactic** —
the ones a static rule must either cry wolf about or miss entirely.

The primary consumer is a coding agent that runs the CLI, reads stdout and applies the fix
itself. There is no `--fix`. **The message is the product.**

```
fixtures/should-warn/constant-object.tsx
  8:17  warning  useMemo has no effect — constant work, and `label` is only read at line 9; inline the expression and remove the dep array  react/pointless-usememo

✖ 1 problem (0 errors, 1 warning)
1 candidates, 0 skipped statically, 1 judged
```

## hugaw is not a React linter

React is the first *plugin*. `src/core` contains zero React knowledge and zero
TypeScript-specific knowledge, and `src/core/architecture.test.ts` enforces that
mechanically. A future `python` adapter plus `django` plugin requires no change to core.

| Seam | Responsibility | MVP implementation |
| --- | --- | --- |
| `LanguageAdapter` | parse files, run selectors, resolve symbols | `typescript` via ts-morph |
| `Plugin` | bundles rules and slice extractors for one language | `react` |
| `Rule` | select / skip / context / ask / decide | `react/pointless-usememo` |

## The rule pipeline

Every rule is five functions. **Only `ask` costs money.**

| fn | runs | costs | does |
| --- | --- | --- | --- |
| `select` | local, AST | no | find candidate nodes |
| `skip` | local, AST | no | discard candidates that are provably fine |
| `context` | local | no | declare which state slices are needed |
| `ask` | **API** | **yes** | the questions the AST cannot answer |
| `decide` | local | no | probabilities → finding or null |

Batching is the runner's job, not the rule's. The runner runs every enabled rule's `select`
and `skip` over a file (all free), groups survivors by **unit** (one component, one
function), unions the context slices the triggered rules asked for, builds that state
**once**, merges every rule's `ask()` into **one** request namespaced `${ruleId}::${qid}`,
then hands each rule only its own answers.

Rules are authored independently and execute batched. That is what keeps cost at roughly
$0.0003 per PR.

## Install

```sh
pnpm add -D hugaw
export TYPESAFE_API_KEY=...   # or put it in .env; never in the config file
```

## CLI

```
hugaw [globs]
  --rule <id>          run only this rule
  --format <name>      stylish (default) | json | eslint-formatter-*
  --max-warnings <n>   exit 1 when warnings exceed this count (-1 disables)
  --max-findings <n>   truncate, announcing the truncation (0 disables)
  --dry-run            print the exact request payloads, call nothing
  --no-cache           bypass the judgment cache
  --config <path>      path to a hugaw config file
```

`--dry-run` is the debugging tool: it prints the complete payload — state, questions and
model — that *would* be sent, and calls nothing. It needs no API key, and the SDK is not
even loaded on that path.

```sh
hugaw src/Price.tsx --dry-run
```

Exit codes follow ESLint: `0` clean or warnings only, `1` an error-severity finding or
warnings above `--max-warnings`, `2` the run was incomplete (config error, adapter failure,
judge error).

## Output

`--format json` emits ESLint's `LintResult` schema verbatim with absolute paths, and keeps
stdout pure JSON — the stats line goes to stderr. `--format stylish` uses paths relative to
cwd (cheaper agent context) and writes no ANSI unless stdout is a TTY. Any other name
resolves `eslint-formatter-<name>` as an optional peer dependency.

An empty result is never silent:

```
✓ no findings · 14 candidates, 14 skipped statically, 0 judged
```

## Config — `hugaw.config.ts`

```ts
import { defineConfig } from "hugaw"
import react from "hugaw/react"

export default defineConfig({
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["**/*.test.tsx", "**/*.stories.tsx"],
  tsconfig: "./tsconfig.json",
  model: "jev-1.13.0",
  plugins: [react],
  rules: {
    "react/pointless-usememo": ["warn", { messageSuffix: "See docs/perf.md." }],
  },
})
```

### Project context

Some facts about a codebase no AST extractor can supply. `context` is plain text that reaches
the model as a `context` field in the request state, set for every rule or for one:

```ts
export default defineConfig({
  context: "This app ships to low-end Android devices.",
  plugins: [react],
  rules: {
    "react/pointless-usememo": ["warn", { context: "`cols` often exceeds 500 entries." }],
  },
})
```

(A rule author's `Rule.context` is a different thing — the list of slice names a rule
requests. They live in different types and never meet.)

Rule-level context is appended to the top-level entry, separated by a blank line.
Whitespace-only text is treated as absent. When one request batches several rules whose
context differs, the field is keyed by rule id; text shared by every rule stays a plain
string. Each contributing rule's questions gain a short `Take \`context\` into account.`
citation, because a state field no question names tends to be ignored.

**It is not free.** It rides on every request for that rule, on top of a small fixture's
~294-token questions and ~164-token state. Measured: a 140-character entry added ~55 input
tokens per request. Keep it short and specific.

**It works, and it is worth measuring.** Text that answers the question being asked moves the
verdict decisively; text that does not, does not:

| case | context | before | after |
| --- | --- | --- | --- |
| prop to a non-memo child | components are memoized by an HOC | identity 0.16 → **warns** | identity 0.74 → silent |
| prop to a non-memo child | project ships on Fridays | identity 0.16 → warns | identity 0.15 → **still warns** |
| cross-file callee | that callee regexes the whole i18n bundle | cost 0.08 → **warns** | cost 2.97 → silent |
| bounded literal | this component is on the scroll hot path | cost 0.90 → warns | cost 0.86 → **still warns** |

The third row is the useful one: the MVP has no digest pass, so a cross-file callee with a
reassuring name is judged cheap — the exact false positive `CALIBRATION.md` case C predicts.
Context is the manual fix for it until the digest pass lands. The fourth row is the honest
limit: the cost question asks how much work the computation does *per render*, so telling it
the component renders often does not, and should not, change the answer.

Listing a plugin turns its rules on at their `meta.defaultSeverity`; `"off"` disables one.
Rule options are `message` and `messageSuffix` only — thresholds are module constants in the
rule file, not config. `cache`, `limits` and `resolve` are accepted and type-checked but are
MVP placeholders behind real interfaces.

`TYPESAFE_API_KEY` comes from the environment only, never the config file.

## The one MVP rule — `react/pointless-usememo`

`select` finds every `useMemo` imported from React (named, namespace or default import,
resolved syntactically so no `@types/react` is required). That is the *only* static gate:
deciding what counts as a candidate, not whether a candidate is fine.

**This rule has no `skip`.** It used to: five static "this one is provably legitimate"
checks, for a memoized child's prop, a dependency array, a context value, a comparing hook
argument, and a value escaping the component. They were deleted, because encoding
"definitely fine" in static rules is exactly the failure hugaw exists to avoid — and they
were twice wrong in practice, once bypassed by a member-access chain and once silencing a
memoised string returned from a custom hook, where identity cannot matter at all.

Every fact those checks encoded is now a *description* in `value_usages`, and the model
decides:

| the old skip | what the model is told instead |
| --- | --- |
| memo-child prop | `` `style` passed as the `style` prop to <Row>, which is wrapped in React.memo and compares its props by reference `` |
| dependency array | `` `value` listed in the dependency array of useEffect() `` |
| context value | `` `cfg` passed as the `value` prop of <ThemeContext.Provider>, so every consumer of that context receives it `` |
| escapes the unit | `` `label` returned directly from the custom hook `useLabel`, so callers outside this file receive it `` |
| | `` `value` assigned to `ref.current`, a member that outlives this render `` |
| comparing hook argument | `` `key` passed to the hook useQuery() `` |

Accuracy matters more than prose here: every one of these is resolved through the same
predicates that used to feed the skips — `isReactApi`, `isMemoComponentTag`,
`contextValueTagOf` — and where a fact cannot be resolved the usage is marked unresolved
rather than guessed at.

What survives is judged on two questions over four context slices
(`component_source`, `memo_call`, `value_usages`, `callee_sources`), and reported only when
the evidence is one-sided:

```ts
const IDENTITY_MATTERS_MAX    = 0.4   // weak evidence of legitimacy is enough to stay quiet
const COST_MAX                = 1.2
const MIN_CONFIDENCE          = 0.6
const UNBOUNDED_WORK_MASS_MIN  = 0.5
```

The asymmetry is deliberate: **weak** evidence of legitimacy suppresses, **strong** evidence
of pointlessness reports. The burden of proof is on the linter.

The cost rubric only asks what the payload can answer. Its levels split on whether a
collection's size is *bounded in the code we sent* — an inline literal versus a prop array
that could hold thousands of entries — rather than on whether a collection is "typically
small", which is a runtime guess the model has no evidence for.

### Does the memo skip work on renders that actually happen?

A `useMemo` also earns its keep by doing nothing on renders where its deps are unchanged, and
that is **computed, never asked**: `renderTriggers` collects the component's reactive inputs
(props, `useState`/`useReducer` values, `useContext` results, other hook results — React's own
resolved through `isReactApi`, and setters excluded because they are stable). When the
dependency array is a *proper* subset of those inputs, some renders provably leave every dep
unchanged, and a memo doing real work there is suppressed.

Cost evidence is read as **probability mass, not expected score**, everywhere it matters. An
expected score of 1.0 can mean "confidently one pass over a bounded literal" or "evenly split
between constant work and an unbounded pass", and those are different facts. So more than
half the mass on the unbounded levels suppresses outright. The message phrase follows the
distribution's **mode** for the same reason — rounding an expected score onto a level the
model gave zero mass would state a specific claim the model never made.

`rendersWithUnchangedDeps` is **reported in `facts`, not gated on**. A gate over it was
written and removed: it needed a threshold no live ablation supports, and small work skipped
often is still only small work saved. The signal is carried so that ablation is cheap to run
later. And when the deps cover every input exactly, whether the memo pays off depends on
whether callers re-render with stable props — the same cross-file problem as `React.memo`,
and out of MVP scope.

`callee_sources` inlines the body of any function the factory calls that is declared in the
same file *and is actually a function* — a `FunctionDeclaration`, or a binding whose
initializer is a function or arrow. This is what earns the rule its accuracy: see
`CALIBRATION.md`, where two identical call shapes get opposite verdicts (2.00 vs 0.11)
decided purely by the inlined body.

Everything else — a callee bound to a prop, a parameter, or a cross-file import — goes into
`unresolved` and drives a caveat clause, because there is no digest pass in the MVP and
name-based inference is not reliable. Recording a name as though it were a body would be
worse than recording nothing: it invites a confident judgment about code the model has
never seen.

A caveat names the blind spot it actually found: usages hidden behind a spread and usages
that could not be classified are counted and worded separately, so an agent is never sent
hunting for a spread that is not there.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test          # everything mocked; zero network
pnpm build
pnpm test:live     # HUGAW_LIVE=1, one opt-in call against the real API
```

Fixtures live in three buckets that encode the cost model:

- `should-warn/` — reaches the model and reports
- `should-skip/` — *(removed for `pointless-usememo`, which has no `skip`)* dropped before
  any request. A rule that keeps a `skip` still uses it.
- `not-a-candidate/` — `select` never yields a candidate, so nothing is requested. This is
  what is left of the free bucket.
- `should-pass/` — reaches the model and *passes* the gates in `decide`, so nothing is
  reported. It was checked and cleared; that is the difference from `should-skip`, which was
  never checked at all.

## Adding fixtures for a new rule

Fixtures live under `fixtures/<rule name>/`, in the same three buckets — `should-warn`,
`should-skip` (only where the rule has a `skip`), `should-pass`, and `not-a-candidate` for
cases `select` rejects. `_`-prefixed files are support files for the fixture
beside them and stay in that bucket, because the fixture imports them by relative path.

Keep the set small and deliberate:

- **One canonical fixture per bucket.** These back the CLI and end-to-end tests, which need
  real files on disk.
- **A real fixture for every case where cross-file resolution is the thing under test** —
  a memoized component behind a default export, a callee in another module. Nothing else
  reproduces it; an in-memory source has no module graph.
- **Everything else in memory**, via `project.createSourceFile()` in `analysis.test.ts` or in
  the rule's own test. Single-function behaviour, threshold tables and message construction
  need no file on disk, and a test that builds its own source reads better than one that
  sends you to another directory to find out what it is asserting.

Rough budget: about three fixtures, plus one per cross-file case.

`pointless-usememo` predates this convention and carries ~35. They are kept because each one
encodes a real regression — several were added in response to a false positive on production
code — but applying the convention retroactively would land somewhere around 12. Do not treat
its fixture count as the standard to match.

## Out of MVP scope

`--fix`, the cross-file digest pass, real caching, `limits.maxRequests`,
`resolve.digestDepth`, `React.memo` pointlessness, an ESLint plugin wrapper, watch mode and
baseline files. Every placeholder sits behind a real interface, so filling it in later
touches one file.
