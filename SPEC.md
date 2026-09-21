# hugaw — MVP spec

`hugaw` is Cebuano for *dirt*. Code that violates a rule is dirt that needs cleaning.

A **context-aware linter**. Where ESLint/oxc decide from the AST alone, hugaw sends a
bounded slice of resolved context to a small calibrated judgment model
(TypeSafe Jev) and decides from a probability. It exists to catch defects that are
**semantic, not syntactic** — the ones a static rule must either cry wolf about or miss.

Primary consumer: **a coding agent** (Claude Code) that runs the CLI, reads stdout,
and applies fixes itself. There is no `--fix`. The message *is* the product.

---

## 1. Non-negotiable architectural requirement

**hugaw is not a React linter.** React is the first *plugin*. The core must contain
zero React knowledge and zero TypeScript-specific knowledge. Three seams:

| Seam | Responsibility | MVP implementation |
|---|---|---|
| `LanguageAdapter` | parse files, run selectors, resolve symbols | `typescript` via ts-morph |
| `Plugin` | bundles rules + slice extractors for one language | `react` |
| `Rule` | select / skip / context / ask / decide | one rule |

A future `python` adapter + `django` plugin must require **no change to `src/core`**.
Reviewers should treat any React or ts-morph import inside `src/core/**` as a defect.

---

## 2. The rule pipeline

Every rule is five functions. Only `ask` costs money.

| fn | runs | costs | does |
|---|---|---|---|
| `select` | local, AST | no | find candidate nodes |
| `skip` | local, AST | no | discard candidates provably fine |
| `context` | local | no | declare which state slices are needed |
| `ask` | **API** | **yes** | the questions the AST cannot answer |
| `decide` | local | no | probabilities → Finding or null |

**Batching is the runner's job, not the rule's.** The runner:
1. runs every enabled rule's `select` + `skip` over a file (all free)
2. groups surviving candidates by **unit** (one component / one function)
3. unions the `context` slices all triggered rules asked for, builds state **once**
4. merges every rule's `ask()` into **one** TypeSafe request, namespaced `${ruleId}::${qid}`
5. hands each rule only its own answers, calls `decide`

Rules are authored independently and execute batched. This is what keeps cost at
~$0.0003/PR (jev-1.13.0: $0.042/M input, output free, 64k ctx, 1200 req/min).

---

## 3. The one MVP rule — `react/pointless-usememo`

### select
Every `CallExpression` whose callee is `useMemo` (imported from `react`).

### skip — static escape hatches, zero cost
Return a reason string (candidate dropped, never judged) when **provably justified**:
- the memoized binding is passed as a prop to a component declared via `React.memo(...)`
- the binding appears in any hook's dependency array
- the binding is used as a context `value`

Most legitimate `useMemo` dies here. This is the function that decides whether the
tool is trusted — every check added here is a false positive that can never happen.

### context slices
`component_source`, `memo_call`, `value_usages`, `callee_sources`

- `value_usages` — every reference to the memoized binding inside the component,
  each with line + a short description of how it is consumed.
- `callee_sources` — for functions called inside the memo factory: if declared in the
  **same file**, inline the source. If cross-file, record the name under
  `unresolved` (MVP has no digest pass — see §7).

### ask — one request, two questions
```ts
cost: score("How expensive is the computation inside `memo_call`?", [
  "Constant work: a property read, arithmetic, string formatting, or an object literal with a few static fields",
  "Work over a collection that is typically small: one map, filter, or find",
  "Work over a collection that may be large, or a sort, groupBy, or nested iteration",
  "Heavy: parsing, regex over large text, recursive tree building, or a known-expensive library call",
])

identity_matters: noul(
  "Does any consumer in `value_usages` depend on this value keeping the same reference across renders?",
  { true:  "It reaches a memoized component, a hook dependency array, a context value, or a reference comparison",
    false: "Every consumer only reads the value during render; a fresh reference each render is harmless" }
)
```
Score returns a probability-weighted position over levels 0..3 plus `confidence`.
Noul returns one probability and **no** confidence.

### decide — plain code, thresholds are module constants
```ts
const IDENTITY_MATTERS_MAX = 0.4   // weak evidence of legitimacy is enough to stay quiet
const COST_MAX             = 1.2
const MIN_CONFIDENCE       = 0.6
```
Order: bail if `identity_matters > IDENTITY_MATTERS_MAX`; bail if `cost.score > COST_MAX`;
bail if `cost.confidence < MIN_CONFIDENCE`; else report.

The asymmetry is deliberate: **weak** evidence of legitimacy suppresses, **strong**
evidence of pointlessness reports. Burden of proof is on the linter.

### message
Single dense line including the fix. A caveat clause is appended **only when there is
a real blind spot** — `unresolved.length > 0`, or `identity_matters` between 0.2 and
`IDENTITY_MATTERS_MAX`. Never boilerplate.

```
useMemo has no effect — constant work, and `label` is only read at line 3; inline the expression and remove the dep array
```
with caveat:
```
… ; 2 of 5 usages unresolved behind a spread — verify before removing
```

---

## 4. Output — ESLint compatible

### `--format stylish` (default)
```
src/Price.tsx
  2:17  warning  useMemo has no effect — constant work, and `label` is only read at line 3; inline the expression and remove the dep array  react/pointless-usememo

✖ 1 problem (0 errors, 1 warning)
```
- relative paths in console (cheaper agent context), absolute in JSON
- no ANSI unless `process.stdout.isTTY`
- never truncate silently — if `--max-findings` trims, print `… showing N of M findings. Re-run with --max-findings 0 for the rest.`
- empty result must be unmistakable: `✓ no findings · 14 candidates, 14 skipped statically`
- always print the stats line: `N candidates, N skipped statically, N judged`

### `--format json` — ESLint's result schema verbatim
Array of `{ filePath, messages[], suppressedMessages: [], errorCount, fatalErrorCount,
warningCount, fixableErrorCount: 0, fixableWarningCount: 0, usedDeprecatedRules: [] }`.
`messages[]` entries: `{ ruleId, severity (1=warn|2=error), message, line, column,
endLine, endColumn, nodeType, messageId }`. No `fix` field.

Any other `--format <name>` resolves `eslint-formatter-<name>` as an optional peer dep
and passes our results straight in.

### exit codes
`0` clean or warnings only; `1` any error-severity finding, or warnings exceeding
`--max-warnings`. Same semantics as ESLint.

---

## 5. Config — `hugaw.config.ts`
```ts
import { defineConfig } from "hugaw"
import react from "hugaw/react"

export default defineConfig({
  files:   ["src/**/*.{ts,tsx}"],
  ignores: ["**/*.test.tsx", "**/*.stories.tsx"],
  tsconfig: "./tsconfig.json",
  model: "jev-1.13.0",
  plugins: [react],
  rules: {
    "react/pointless-usememo": ["warn", { messageSuffix: "See docs/perf.md." }],
  },
})
```
Rule options for MVP: **`messageSuffix` and `message` only** (string with `{placeholders}`
or a typed function over the rule's exposed facts). No `strictness`. No `thresholds` —
those are module constants in the rule file.

`cache`, `limits`, `resolve` are accepted and type-checked but **placeholders** (§7).

`TYPESAFE_API_KEY` comes from the environment only, never the config file.

---

## 6. CLI
```
hugaw [globs]
  --rule <id>          run only this rule
  --format <name>      stylish (default) | json | eslint-formatter-*
  --max-warnings <n>
  --max-findings <n>   truncate, announcing the truncation
  --dry-run            print the exact request payloads, call nothing   ← build this FIRST
  --no-cache
```

`--dry-run` must work end to end before any network code lands. It is how every bad
finding gets debugged later.

---

## 7. Explicitly OUT of MVP scope
- `--fix` and any codemod machinery — the agent fixes
- the **digest pass** (second Jev call to summarize cross-file callees/hooks).
  Same-file callees are inlined; cross-file ones go in `unresolved` and drive the caveat.
- real caching — ship a `Cache` interface with a no-op implementation behind it
- `limits.maxRequests`, `resolve.digestDepth`, `resolve.knownHooks` — typed in config, unused
- `React.memo` pointlessness (needs a cross-file reverse JSX index)
- ESLint plugin wrapper, watch mode, baseline files, array/per-glob config

Ship the seams, not the features. Every placeholder must sit behind a real interface
so filling it in later touches one file.

---

## 8. Stack & gates
pnpm 9 · Node 22 · TypeScript strict · ESM

`ts-morph` (parse + resolve — chosen over oxc because cross-file resolution *is* the
product and the bottleneck is the network, not the parser) · `@typesafe-ai/sdk` ·
`cac` · `picocolors` · `p-limit` · `zod` (config validation) · `tsup` (build) · `vitest`

Gates: `pnpm typecheck` and `pnpm test` must be green. No ESLint config for MVP.

## 9. Fixtures — `fixtures/`, three buckets

> **Historical paths and names.** Fixtures were regrouped per rule on 2026-09-21; the three
> buckets now live under `fixtures/<rule name>/`, and `should-stay-silent/` was renamed
> `should-pass/`. The buckets' *meanings* below are unchanged: `should-pass` reaches the
> model and passes the gates, as distinct from `should-skip`, which never reaches it.

~15 small `.tsx` files, each a table-driven vitest case:
- `should-warn/` — constant work, no identity consumer (the Price example)
- `should-skip/` — must be dropped by `skip` with **zero** API calls (memo child, dep array, context value)
- `should-stay-silent/` — reaches the model but `decide` returns null (expensive computation)

`should-skip` tests must assert the judge was **never invoked** — inject a mock judge
and assert zero calls. That assertion is the cost model.

Judge calls in tests are mocked by default. One opt-in integration test hitting the
real API behind `HUGAW_LIVE=1`, skipped otherwise.
