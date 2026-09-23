# Running hugaw

hugaw lints for defects a static rule cannot decide: it collects a bounded slice of resolved
code around each candidate, sends it to a small calibrated judgment model (TypeSafe Jev,
which returns typed probabilities rather than text), and decides in plain code from the
numbers it gets back.

Two rules ship, both React: `react/pointless-usememo` and `react/useeffect-alternatives`.

There is no `--fix`. The intended reader of the output is a coding agent that applies the
change itself, so the message carries the fix and the caveats, and nothing else does.

For how any of that works inside, see [internals.md](./internals.md).

## Requirements

- Node 22 or newer.
- A `TYPESAFE_API_KEY`, from the environment or a `.env` file in the working directory.
  Node reads `.env` natively here and never overwrites a variable that is already set, so a
  CI-provided key wins over a checked-out file. The key is never read from the config file.
- TypeScript or JavaScript sources. A `tsconfig.json` is optional. Without one, hugaw parses
  with permissive settings of its own; React detection is syntactic (it follows the import,
  not the type), so `@types/react` is not required.

## Install and run

```sh
pnpm add -D hugaw
export TYPESAFE_API_KEY=...      # or put it in .env
pnpm hugaw "src/**/*.tsx"      # quote the glob: hugaw expands it, not the shell
```

Working inside this repository instead:

```sh
pnpm install
pnpm build
node dist/bin.js fixtures/pointless-usememo/should-warn/constant-object.tsx --dry-run
```

## Start with `--dry-run`

`--dry-run` prints the exact request that *would* be sent, for every candidate, and calls
nothing. It needs no API key and the vendor SDK is not even loaded on that path, so it costs
nothing and cannot fail on credentials.

```sh
hugaw src/Price.tsx --dry-run
```

You get JSON: one entry per request, each with the unit it covers, the candidates in it, the
model, the full `state` (every slice of code that leaves your machine) and the full
`questions`. Plus the run's stats. Read it before the first real run, both to see what is
being sent and to see what is *not*.

## Running for real

```sh
hugaw "src/**/*.{ts,tsx}"
```

Output, in ESLint's stylish layout:

```
src/Price.tsx
  8:17  warning  useMemo has no effect: constant work, and `label` is only read at line 9; inline the expression and remove the dep array  react/pointless-usememo

✖ 1 problem (0 errors, 1 warning)
1 candidates, 0 skipped statically, 1 judged
```

Reading one finding:

- `8:17` is where the `useMemo` or `useEffect` call starts, 1-based, as ESLint reports it.
- The message is one line and is meant to be acted on directly. It has a fixed shape: what
  was observed, then a semicolon, then the fix, then any caveats, each introduced by another
  semicolon.
- The rule id is last.

The last line is always printed, including on a clean run:

```
✓ no findings · 14 candidates, 14 skipped statically, 0 judged
```

`candidates` is how many `useMemo`/`useEffect` calls were found, `judged` is how many
reached the model. An empty result is never silent, and a run that hit errors never prints
`✓`: it prints `⚠ no findings, but the run was incomplete (N errors; see stderr)` instead, so
a reader cannot mistake a broken run for a clean file.

### What the run cost

When a run spends anything, the stats line says so:

```
38 candidates, 0 skipped statically, 38 judged · 55.3k tokens · $0.0022 @ $0.042/M
```

The rate is printed beside the total deliberately. It comes from a small table keyed by the
model id the API *reports* (not the one you configured, since `jev-latest` is an alias), and
a model the table does not know prints its token count with no dollar figure at all, rather
than borrowing another model's rate. A run that spent nothing, such as a dry run, prints no
cost clause: `0 tokens · $0.0000` would invite you to check a number that means "we did not
ask".

## Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--dry-run` | off | Print the request payloads, call nothing. No API key needed. |
| `--rule <id>` | all | Run only this rule, by full id: `react/pointless-usememo`. An unknown id exits 2 and lists the known ones. |
| `--format <name>` | `stylish` | `stylish`, `json`, `json-with-metadata`, or any `eslint-formatter-<name>` you have installed. |
| `--max-warnings <n>` | `-1` | Exit 1 when warnings exceed `n`. `-1` disables the ceiling. |
| `--max-findings <n>` | `0` | Show at most `n` findings and announce the trim. `0` disables. The run still produces all of them; this is a display limit. |
| `--config <path>` | auto | Path to a config file. Without it, hugaw walks up from the working directory looking for `hugaw.config.ts`, `.mts`, `.js` or `.mjs`. |
| `--no-cache` | n/a | Accepted. Caching is a no-op in this version, so it changes nothing today. |

Positional globs override `files` from the config; `ignores` still applies to them.

### Exit codes

- `0` clean, or warnings only.
- `1` an error-severity finding, or warnings above `--max-warnings`.
- `2` the run did not complete: config error, adapter failure, missing API key, judge error,
  a formatter that is not installed, or any per-file error during the run.

`2` means "do not trust this result", not "your code is worse". Treat it as a broken run.

## `--format json` for CI

`--format json` emits ESLint's `LintResult[]` verbatim, with absolute paths, and nothing
else: stdout stays pure JSON and the human stats line goes to stderr, so a pipe into `jq`
works unchanged.

```sh
hugaw "src/**/*.tsx" --format json > findings.json
```

`--format json-with-metadata` is ESLint's own name for `{ results, metadata }`. `results` is
byte-identical to the above; `metadata` adds `rulesMeta`, `usage` and `findings`.

```sh
hugaw "src/**/*.tsx" --format json-with-metadata | jq .metadata.usage
```

```json
{
  "model": "jev-1.13.0",
  "requests": 36,
  "inputTokens": 52788,
  "outputTokens": 2523,
  "estimatedCostUsd": 0.002217096,
  "rate": { "inputPerMTok": 0.042, "outputPerMTok": 0 }
}
```

`requests` sits below `judged` because several candidates in one component are batched into
one request. Output tokens are counted in the token total but not in the cost, because they
are free at this rate. For an unpriced model `estimatedCostUsd` and `rate` are omitted
entirely, so nothing sums a zero it mistakes for a measurement.

`metadata.findings` carries each finding's `facts`: the probabilities, the masses and the
statically computed evidence behind the verdict, with enough location to join back onto
`results`.

```sh
hugaw "src/**/*.tsx" --format json-with-metadata | jq '.metadata.findings[0].facts'
```

This is where the numbers live, and deliberately the only place. No probability ever appears
in a message: a number in prose that you would not act on is just a distribution leaking
into your sentence, and `or (43%) compute it during render` tells a reader nothing they can
use. The messages say what to do and what could not be verified; `facts` is for anything
that computes.

## Config

`hugaw.config.ts` in your project root:

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
    "react/useeffect-alternatives": "error",
  },
})
```

Defaults if you omit them: `files` is `["**/*.{ts,tsx}"]`, `ignores` is node_modules and
dist, `model` is `jev-1.13.0`. With no config file at all you get the TypeScript adapter and
the React plugin, and a note on stderr saying so.

Listing a plugin turns on every rule it owns, at that rule's own default severity (`warn`
for both shipped rules). Naming one rule in `rules` does not disable the others; `"off"` is
the only way to turn a rule off.

`cache`, `limits` and `resolve` are accepted and type-checked but are not implemented yet.

### The three per-rule options

A rule setting is either a severity string or `[severity, options]`. There are exactly three
options, and they do different kinds of work:

**`context`** is free text that reaches the model as part of the request. It is the only
option that can change a verdict.

```ts
export default defineConfig({
  context: "This app ships to low-end Android devices.",
  plugins: [react],
  rules: {
    "react/pointless-usememo": ["warn", { context: "`cols` often exceeds 500 entries." }],
  },
})
```

Set at the top level it applies to every rule; set per rule it is appended to the top-level
text after a blank line. Whitespace-only text counts as absent. Each contributing rule's
questions gain a short instruction to take it into account, because a state field no
question mentions tends to be ignored.

It is not free. It rides on every request for that rule. Measured against a small fixture
whose questions are around 294 tokens and whose state is around 164, a 140-character entry
added about 55 input tokens per request. Keep it short and specific.

It also only works when it answers the question being asked. Measured, on the memo rule:

| case | context | before | after |
| --- | --- | --- | --- |
| prop passed to a non-memo child | children are memoized by an HOC | identity 0.16, warns | identity 0.74, silent |
| prop passed to a non-memo child | the project ships on Fridays | identity 0.16, warns | identity 0.15, still warns |
| cross-file callee | that callee regexes the whole i18n bundle | cost 0.08, warns | cost 2.97, silent |
| bounded literal | this component is on the scroll hot path | cost 0.90, warns | cost 0.86, still warns |

The third row is the useful one: it is the manual fix for a cross-file callee whose body
hugaw cannot read. The fourth is the honest limit: the cost question asks how much work
happens per render, so telling it the component renders often does not, and should not,
change the answer.

**`message`** replaces the rule's message entirely. A string may contain `{factName}`
placeholders, filled from that finding's facts; unknown names are left alone. A function
receives the facts object and returns the string.

**`messageSuffix`** appends text after a single space.

Neither `message` nor `messageSuffix` changes what is sent, what is asked, or whether a
finding is produced. They change only what you read.

Severity sets the exit code: `"warn"` findings alone exit 0 (unless `--max-warnings` is
exceeded), `"error"` findings exit 1.

Thresholds are not configurable. They are module constants in each rule file, set from live
measurements recorded in the [Calibration](internals.md#calibration) section of `internals.md`.

### Overriding a rule's criteria

The effect rule's outcomes are a fixed list, but the *text* describing each one can be
replaced per project. This is how you teach it your codebase's vocabulary — that every query
has a generated hook, that your store is not Redux — without forking the rule.

```ts
"react/useeffect-alternatives": ["error", {
  extends: {
    replacements: {
      // a string replaces the criterion and keeps the built-in fix phrase
      external_store: "Replace the state and the effect with `useSyncExternalStore`. …",

      // the object form replaces both
      data_library: {
        criterion: "Replace the effect and the state it fills with this codebase's generated `useXQuery` hook. …",
        fix: "replace the effect with the generated `useXQuery` hook, and delete {state}",
      },
    },
  },
}]
```

**Override the fix whenever you override the criterion.** A criterion that talks about your
generated hooks, paired with the built-in fix that says "the project's data-fetching hook",
means the model read one thing and the reader is told another. That is what the object form
is for.

A `fix` takes the same `{placeholder}` names as `message`: any fact, plus `{state}`, `{dep}`,
`{callback}`, `{external}` and `{owner}`. **A clause whose placeholder cannot resolve is
dropped**, rather than printed as a hole or an empty string — `"use the hook, and delete
{state}"` becomes `"use the hook"` on a finding where no state write was confirmed. If every
clause drops, the built-in phrase is used instead, because a finding without a fix is not a
finding. Config fixes go through the same length budget and punctuation rules as the built-in
ones, and an em-dash is rejected at load.

Only labels that already exist can be overridden; a typo fails at load with the config path
and the list of valid labels. A successful override prints a notice on stderr naming what
changed, because the thresholds were measured against the built-in criteria and changing them
can move the gate.

## The rules

### `react/pointless-usememo`

Reports a `useMemo` whose computation is cheap *and* whose value no consumer compares by
reference. Both halves have to hold. It has no static escape hatch: every `useMemo` imported
from React is judged, because encoding "this one is definitely fine" in a static rule is the
failure mode the tool exists to avoid.

Before:

```tsx
function format(amount, currency) {
  return `${currency}${amount.toFixed(2)}`
}

export function Price({ amount, currency }) {
  const label = useMemo(() => ({ text: format(amount, currency) }), [amount, currency])
  return <span className="price">{label.text}</span>
}
```

```
  8:17  warning  useMemo has no effect: constant work, and `label` is only read at line 9; inline the expression and remove the dep array  react/pointless-usememo
```

After:

```tsx
export function Price({ amount, currency }) {
  const label = { text: format(amount, currency) }
  return <span className="price">{label.text}</span>
}
```

The burden of proof is on the linter, in both directions: weak evidence that the memo is
legitimate is enough to stay quiet, while reporting requires strong evidence that it is
pointless. A memo whose value reaches a `React.memo` child, a dependency array, a context
value, a ref, or a custom hook's return value is left alone. So is one whose computation
runs over a collection whose size the code does not bound.

### `react/useeffect-alternatives`

Reports a `useEffect` that a React primitive would do better: derived state computed during
render, an event handler, a `key` that remounts, `useSyncExternalStore`, a data-fetching
hook, module scope, and others. `useLayoutEffect` and `useInsertionEffect` are not
candidates: their existence is usually justified by timing, which this rule does not reason
about.

Before:

```tsx
export function ProductList({ products }) {
  const [filtered, setFiltered] = useState([])

  useEffect(() => {
    setFiltered(products.filter((p) => p.inStock))
  }, [products])

  return <ul>{filtered.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
}
```

```
  6:3  warning  useEffect should not exist: sets `filtered` from `products`; compute it during render (use `useMemo` if the work is expensive) and delete the state and the effect  react/useeffect-alternatives
```

After:

```tsx
export function ProductList({ products }) {
  const filtered = products.filter((p) => p.inStock)
  return <ul>{filtered.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
}
```

The rule produces two kinds of finding, gated in opposite directions. Most say the effect
should not exist and name the replacement. One says the opposite: an effect that genuinely
synchronises with an external system once on mount is reported as something to *keep*,
wrapped in the project's `useMountEffect`, so the intent is explicit and the lint suppression
lives in one place.

The half of the message before the semicolon is built from static facts only, never from the
model. The fix is a judgment and is allowed to be wrong; the sentence describing the code you
are about to delete has to be true of it.

## What it costs

Rate: `jev-1.13.0` is $0.042 per million input tokens, with output free. Measured runs from
this repository:

| run | work | cost |
| --- | --- | --- |
| a recorded run over `fixtures/` | 38 candidates, 38 judged, 36 requests, 52,788 input + 2,523 output tokens | $0.0022 |
| `sample/`, one rule | 5 candidates, 5 judged, 21.5k tokens | $0.0009 |
| memo calibration | 6 judgments, 3,634 input tokens | $0.000153 |
| effect calibration | 17 cases, 78,675 input tokens | $0.0033 |

Two things hold the cost down: nothing is asked that the AST can answer, and every rule
firing on the same component is merged into a single request. A pull-request-sized run lands
in fractions of a cent.

## When a finding looks wrong

Run the same file with `--dry-run` and read what was actually sent.

Most wrong findings are a missing piece of context, not a bad judgment. The model answered
correctly about the code it was given; the code it was given was incomplete. Two shapes are
common:

- A function called inside the memo factory or the effect body lives in another file. hugaw
  does not read it. It goes into `unresolved` in the payload and the model has nothing but
  the name to go on, which is exactly as unreliable as it sounds.
- A fact about your codebase that no extractor could supply: that a prop routinely holds
  thousands of entries, that children are memoized by an HOC at export, that a
  reassuringly-named helper actually parses a large bundle.

Both are fixed with `context` in the config, and the table above shows the size of the
effect: a sentence describing what a cross-file callee really does moved one case from
reported to silent.

Read the caveat clauses. They are not boilerplate and they are not appended unless there is
a real blind spot, so when one is present it marks something hugaw could not see:

- `1 callee (slugify) unresolved across files, verify before removing` — the body is in
  another file and was not read.
- `2 of 5 usages unresolved behind a spread, verify before removing` — a spread hides which
  fields a consumer reads.
- `N of M usages could not be classified (line 12), verify before removing` — a reference in
  a position the analysis does not recognise. Counted separately from spreads on purpose, so
  you are never sent hunting for a spread that is not there.
- `weak identity signal, verify no consumer compares references` — the evidence was near the
  threshold.
- *`setTotal` looks like a state setter but came from a `useState` that does not resolve to
  React's, so check this file's imports before removing* — something was written, but hugaw
  could not confirm it is React state, so the fix is reasoning about something it did not see.
- *the effect body is `syncTitle`, defined elsewhere, verify before removing* — the callback
  was passed by name and could not be followed to a body.

If the finding still looks wrong after that, `--format json-with-metadata` gives you the
probabilities the verdict was computed from.

## What it deliberately does not do

- **Dependency arrays.** Values an effect reads without listing are carried as a fact and
  surface at most as a `key={…}` suggestion. Never as "add it to the dependency array".
  That is `exhaustive-deps`.
- **Conditional hooks, hook ordering.** That is `rules-of-hooks`.
- **State mutation during render.** Write sites are classified, including ones in render, so
  the model can weigh them, but it is never reported. That is the React Compiler lint.
- **`React.memo` pointlessness**, which needs a reverse index of every JSX call site.
- **Fixing anything.** No `--fix`, no codemods. The message is the product.
- **Reading across files for callee bodies.** Same-file callees are inlined into the payload;
  cross-file ones are named as a blind spot and drive a caveat.

The first three are ESLint's, they are good at them, and hugaw is not trying to replace
them. Run both.
