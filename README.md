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

Listing a plugin turns its rules on at their `meta.defaultSeverity`; `"off"` disables one.
Rule options are `message` and `messageSuffix` only — thresholds are module constants in the
rule file, not config. `cache`, `limits` and `resolve` are accepted and type-checked but are
MVP placeholders behind real interfaces.

`TYPESAFE_API_KEY` comes from the environment only, never the config file.

## The one MVP rule — `react/pointless-usememo`

`select` finds every `useMemo` imported from React (named, namespace or default import,
resolved syntactically so no `@types/react` is required).

`skip` then drops — for free, with **zero** API calls — every candidate that is provably
justified:

| reason | why it is legitimate |
| --- | --- |
| `result is not bound to a simple identifier` | nothing to trace |
| `memoized value escapes the component (returned or assigned outward)` | a custom hook's contract |
| `passed as prop to React.memo component <X>` | identity is the whole point |
| `listed in dependency array of <hook>` | identity drives the effect |
| `used as context value on <Tag>` | identity drives every consumer |
| `passed as an argument to hook <hook>` | the hook may compare its input across renders |

Every positional check runs against the whole **access chain**, not the bare identifier:
`useEffect(…, [data.items])` skips just as `[data]` does, because the field of a memoized
object is fresh on every render once the memo is gone.

The hook-argument skip is the one that needs care in both directions. React's own
`useState`, `useRef` and `useReducer` read their argument once on mount, and the deps-driven
hooks compare only their dependency array — a memo in those positions is pointless, so they
are *excluded* from the skip and the slice states that semantics outright rather than
letting the model infer it from a name. Everything else skips, including hooks we cannot
resolve. Every one of those judgements is gated on the callee actually resolving to React's
export: a local `function useState` shares the name and none of the behaviour, so it is
treated as an unknown hook and skipped.

Most legitimate `useMemo` dies here. Every check added to `skip` is a false positive that can
never happen.

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

- `fixtures/should-warn/` — reaches the model and reports
- `fixtures/should-skip/` — dropped by `skip`; the tests assert the judge was **never invoked**
- `fixtures/should-stay-silent/` — reaches the model, `decide` returns null

## Out of MVP scope

`--fix`, the cross-file digest pass, real caching, `limits.maxRequests`,
`resolve.digestDepth`, `React.memo` pointlessness, an ESLint plugin wrapper, watch mode and
baseline files. Every placeholder sits behind a real interface, so filling it in later
touches one file.
