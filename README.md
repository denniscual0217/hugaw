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
  8:17  warning  useMemo has no effect: constant work, and `label` is only read at line 9; inline the expression and remove the dep array  react/pointless-usememo

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
  --format <name>      stylish (default) | json | json-with-metadata | eslint-formatter-*
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

### What the run cost

Every run says what it spent, on the stats line rather than a line of its own:

```
38 candidates, 0 skipped statically, 38 judged · 55.3k tokens · $0.0022 @ $0.042/M
```

The rate is printed next to the total on purpose. Prices change, and a hard-coded price
that has gone stale should be visible in the output rather than silently wrong. Pricing is
a small table keyed by the model id the API *reports* — not the one configured, because
`jev-latest` is an alias. **A model the table does not know prints its token count and no
dollar figure at all**: a cost derived from another model's rate would look checked and
would not be. A run that spent nothing — a dry run — prints no clause, since `0 tokens ·
$0.0000` invites you to check a number that means "we did not ask".

`--format json` is unchanged and stays a bare `LintResult[]`; the numbers live in
`--format json-with-metadata`, ESLint's own name for `{ results, metadata }`:

```sh
hugaw --format json-with-metadata | jq .metadata.usage
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

Both figures are from a real run over `fixtures/`. `requests` is below `candidates` because
the runner batches every rule firing on one component into a single request, and
`outputTokens` is counted in the token total but not in the cost, because output is free at
this rate. Full precision in JSON — the rounding above is a display concern. `estimatedCostUsd` and
`rate` are omitted entirely for an unpriced model, so nothing sums a zero it mistakes for a
measurement. Both JSON formats keep stdout pure and put the human stats line on stderr.

`metadata.findings` carries each finding's `facts` — the probabilities, the masses, the
statically computed evidence — with enough location to join back onto `results`:

```sh
hugaw --format json-with-metadata | jq '.metadata.findings[0].facts.probabilities'
```

**No probability appears in a message.** A number in prose is either actionable, in which
case it should have moved `decide` instead, or it is not, in which case it is a
distribution leaking into someone else's sentence — `or (43%) compute it during render`
tells a reader nothing they can act on, and nothing at all if they do not know what a
probability mass is. Messages say what to do and what could not be verified; the numbers
live here, where something can compute on them.

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
Rule options are `message`, `messageSuffix` and `context` (above) — thresholds are module constants in the
rule file, not config. `cache`, `limits` and `resolve` are accepted and type-checked but are
MVP placeholders behind real interfaces.

`TYPESAFE_API_KEY` comes from the environment only, never the config file.

## Rules

### `react/pointless-usememo`

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

#### Does the memo skip work on renders that actually happen?

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

### `react/useeffect-alternatives`

`select` finds every `useEffect` imported from React. `useLayoutEffect` and
`useInsertionEffect` are not candidates: their existence is usually justified by timing, and
the decision matrix this rule encodes does not address them. There is no `skip`.

The rule asks the model **one** question: a choice over every outcome an effect can have, from
keeping it as written to each of the ways it could be deleted. It gates on the answer's
*shape* rather than on a second opinion:

```ts
keepFamilyMass = P(keep_effect) + P(mount_effect) + P(effect_event)
```

Above `KEEP_FAMILY_MASS_MAX` (0.5) the rule stays quiet — with one exception: a `mount_effect`
*mode* above the gate is the `wrapMountEffect` finding, since that one keeps the effect rather
than deleting it. Below the gate the mode decides which fix to print, except that a keep-family
mode is still refused, because a distribution that splits its belief across keeping and
deleting is not evidence for either. A second question was written, measured and deleted: the Choice's own distribution separates
"this must go" from "this must stay" by a gap with nothing in it, where the second question's
two wordings both overlapped. `CALIBRATION.md` has the current numbers, and is the place to
read them — they move whenever an option is added to the Choice.

Summing the family, rather than reading the mode, is the whole point. A distribution like
`{keep .30, effect_event .12, mount .05, render .31, memo .22}` has a delete-family mode and
47% of its belief on leaving the effect alone; the mode reports it and prints "30%".

Two findings, gated in opposite directions:

- **`replaceEffect`** — the effect should not exist. One dense line: what it does, then the
  fix. The observation half is built from static facts only (`sets \`filtered\` from
  \`products\``, `calls \`fetchProduct(productId)\` and sets \`product\``), because the fix is a
  judgment and is allowed to be wrong, but the sentence describing the code an agent is about
  to delete has to be true of it.
- **`wrapMountEffect`** — the effect is genuine mount-only synchronisation and should be
  wrapped in the project's `useMountEffect`. This one requires the mode to *be* `mount_effect`,
  not merely the evidence for it: SKILL.md's canonical `useSyncExternalStore` example has empty
  deps, a cleanup and listeners, which is `mount_effect`'s stated evidence verbatim, and telling
  a reader to wrap it would be the opposite of the right answer.

Four slices go on the wire. `component_state` (unit-scoped) carries the props, every
`useState`/`useReducer` pair, and every write site classified by the kind of function it sits
in — `render`, `effect`, `handler`, `callback` — which is what lets "the handler could have
done this directly" be evidence rather than a guess. It also carries each hook result with the
*hook that produced it*, so `const { data } = useGetProductQuery()` can be told from
`const [data] = useToggle()`. `effect_call` carries the deps, their kind, cleanup detection and
the values the effect reads but does not list. `effect_body` classifies every call in the body
by origin — state setter, callback prop, same-file, imported, hook result, global, member,
unresolved — with the nesting that distinguishes `setNow()` in the body from the same call
inside a `setInterval` callback.

**What this rule does not do.** It is not `exhaustive-deps`: values read outside the dependency
array are carried as a fact and surface only as a `key={…}` suggestion on a mount finding,
never as "add it to the dependency array". It does not detect conditional hooks, does not
report state mutation during render, and has no `--fix`.

### Writing a criterion

A `choice` option's criterion is **one string**, and a good one covers three things:

1. **What the option means** — the fix, in the words someone would use to apply it.
2. **What evidence in the payload answers it** — and *name the slice field*, so you cannot
   ask for something the payload does not carry.
3. **Which neighbouring option it is not** — and what would have made that neighbour win.

The evidence habit is not style. An early version of the memo rule's cost rubric had a level
reading "a collection that is typically small" — a size judgement against a payload that
carried no size information anywhere. It matched `items.filter(...)` on a prop array and
shipped a confident false positive on production code. Naming the field you are reasoning
from makes that mistake visible while you are writing the criterion rather than after it
ships.

Write the three parts as one string. The structure is for the author, not the model: the
same words as `{description, evidence, contrast}` and as a single block produce identical
answers and identical probabilities — measured on a plain case and on one built to match two
options at once — while the keys cost about 300 tokens per request. `ChoiceCriterion` in core
still accepts an object, and there is a comment there explaining why it is kept and why you
should not reach for it without measuring first.

When rule options become configurable, `extends.replacements` will take a string per label,
exactly like `context` does today.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test          # everything mocked; zero network
pnpm build
pnpm test:live     # HUGAW_LIVE=1, one opt-in call against the real API
```

Fixtures live in four buckets that encode the cost model:

- `should-warn/` — reaches the model and reports
- `should-skip/` — *(removed for `pointless-usememo`, which has no `skip`)* dropped before
  any request. A rule that keeps a `skip` still uses it.
- `not-a-candidate/` — `select` never yields a candidate, so nothing is requested. This is
  what is left of the free bucket.
- `should-pass/` — reaches the model and *passes* the gates in `decide`, so nothing is
  reported. It was checked and cleared; that is the difference from `should-skip`, which was
  never checked at all.

## Adding fixtures for a new rule

Fixtures live under `fixtures/<rule name>/`, in the same four buckets — `should-warn`,
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

`pointless-usememo` predates this convention and carries 32, plus 5 support files. They are kept because each one
encodes a real regression — several were added in response to a false positive on production
code — but applying the convention retroactively would land somewhere around 12. Do not treat
its fixture count as the standard to match.

## Out of MVP scope

`--fix`, the cross-file digest pass, real caching, `limits.maxRequests`,
`resolve.digestDepth`, `React.memo` pointlessness, an ESLint plugin wrapper, watch mode and
baseline files. Every placeholder sits behind a real interface, so filling it in later
touches one file.
