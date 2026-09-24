# hugaw

A linter for the rules ESLint cannot express. Where a static rule has to decide from the
syntax in front of it, hugaw resolves a bounded slice of real context — the component, what
the value is used for, the bodies of the functions it calls — and sends that to a small
calibrated model that returns typed probabilities rather than text. The decision is then made
in ordinary code against thresholds that came from live measurement.

The consumer is a coding agent: it runs the CLI, reads stdout, and applies the fix itself.
The message is the product.

*hugaw* is Cebuano for dirt.

## What it is not

It is not a replacement for ESLint. `exhaustive-deps`, `rules-of-hooks` and
mutation-during-render are static questions with static answers, and they stay where they
are. There is no `--fix`.

## Using it

```sh
pnpm add -D hugaw
export TYPESAFE_API_KEY=...        # or put it in .env
```

Start with `--dry-run`. It prints the exact request that would be sent for every candidate —
every slice of your code that would leave the machine — and calls nothing. No API key needed,
no cost, and the vendor SDK is not loaded on that path.

```sh
hugaw "src/**/*.tsx" --dry-run     # quote the glob: hugaw expands it, not the shell
```

Then run it for real:

```
$ hugaw fixtures/useeffect-alternatives/should-warn/derived-state.tsx
fixtures/useeffect-alternatives/should-warn/derived-state.tsx
  6:3  error  This effect only sets `filtered` from `products`. Compute it during render (use `useMemo` if the work is expensive) and delete the state and the effect.  react/useeffect-alternatives

✖ 1 problem (1 error, 0 warnings)
1 candidates, 0 skipped statically, 1 judged · 4.4k tokens · $0.0002 @ $0.042/M
```

Every run reports what it spent. Output is ESLint-compatible: `--format json` is ESLint's
`LintResult[]` verbatim, and exit codes match. See [docs/usage.md](docs/usage.md) for flags,
CI output, and what to do when a finding looks wrong.

## The rules

**`react/useeffect-alternatives`** reports a `useEffect` that a React primitive would do
better — derived state, an event handler, a `key`, `useSyncExternalStore`, a data-fetching
hook, a ref callback, module scope — and names which one. It stays quiet when the effect is
genuine synchronisation; it will not tell you to delete a WebSocket subscription.

```tsx
// fixtures/useeffect-alternatives/should-warn/derived-state.tsx
const [filtered, setFiltered] = useState([])
useEffect(() => {
  setFiltered(products.filter((p) => p.inStock))
}, [products])
```
```
  6:3  error  This effect only sets `filtered` from `products`. Compute it during render (use `useMemo` if the work is expensive) and delete the state and the effect.  react/useeffect-alternatives
```

When the write happens inside a local helper, the finding follows it one level and says so,
because the request inlined that helper's body and the model judged on it:

```tsx
// fixtures/useeffect-alternatives/should-warn/setter-through-helper.tsx
function evaluateCount(value) {
  if (value >= 10) setFinished(true)
}
useEffect(() => {
  evaluateCount(count)
}, [count])
```
```
  20:3  error  This effect calls `evaluateCount(count)`, which sets `finished`. Compute the whole next state in the handler that sets `count` and delete the effect. Or compute it during render and delete the state and the effect.  react/useeffect-alternatives
```

Which outcomes it can report, and the measurements behind every threshold, are in
[docs/internals.md](docs/internals.md#calibration).

**`react/pointless-usememo`** reports a `useMemo` whose computation is cheap *and* whose value
no consumer compares by reference. Both halves need context: the cost depends on what `format`
does, and identity depends on where `label` ends up.

```tsx
const label = useMemo(() => ({ text: format(amount, currency) }), [amount, currency])
```
```
  8:17  warning  This useMemo does nothing. The computation is constant work and `label` is only read at line 9. Inline the expression and remove the dep array.  react/pointless-usememo
```

## Configuring it

`hugaw.config.ts` in your project root:

```ts
import { defineConfig } from "hugaw"
import react from "hugaw/react"

export default defineConfig({
  files: ["src/**/*.{ts,tsx}"],
  plugins: [react],
  rules: {
    "react/useeffect-alternatives": ["error", { context: "This app renders 10k-row tables." }],
    "react/pointless-usememo": "warn",
  },
})
```

Listing a plugin turns on every rule it owns; `"off"` is the only way to turn one off. A rule
takes three options, and they do different kinds of work:

- **`context`** is free text that reaches the model. It is the only option that can change a
  verdict — use it to tell the model something true about your codebase that no extractor
  could find.
- **`message`** and **`messageSuffix`** change only what you read, never whether a finding is
  made.
- **`extends.replacements`** rewrites what the effect rule tells the model about one of its
  outcomes.

### Teaching a rule your own hooks

The effect rule can answer `useEffectEvent`, `useMountEffect` and `useLinkedState`, none of
which are React APIs. It describes their *shape*, so it already recognises yours — but if
your version differs, or you want the finding to name your import path, say so:

```ts
"react/useeffect-alternatives": ["error", {
  extends: {
    replacements: {
      // a string replaces the text the model reads for this outcome
      effect_event:
        "Keep the effect, but move the reads that should not re-trigger it into this " +
        "project's `useEffectEvent` from `@/hooks`, which always sees the latest values. " +
        "The effect synchronises correctly on one dependency yet lists another it only " +
        "reads. Not `keep_effect`: that has no over-reactive dependency. Not " +
        "`event_handler`: the effect stays, only a read moves out of it.",

      // an object also replaces the fix printed in the finding
      data_library: {
        criterion: "Replace the effect and the state it fills with this project's " +
          "generated `useXQuery` hook, beside the `.gql` file for that operation. …",
        fix: "replace the effect and {state} with the generated `useXQuery` hook",
      },
    },
  },
}],
```

```
react/useeffect-alternatives: overriding 2 criteria (effect_event, data_library) and 1 fix
(data_library) from config; thresholds were measured against the built-in set

  7:3  error  This effect calls `fetchProduct(productId)` and sets `product`. Replace the
              effect and the `product` state with the generated `useXQuery` hook. …
```

`{state}` resolves from what the run actually observed, and its clause is dropped when nothing
was observed rather than printing a hole.

**Keep the substance of what you replace.** A criterion carries three things: what the outcome
means, what evidence in the payload points to it, and which neighbouring outcome it is *not*.
Writing a shorter one that only says what it means will silence findings, because the model
loses the evidence and the contrasts it was separating fifteen outcomes with. Read the built-in
first — `--dry-run` prints every criterion — and change the naming rather than the scope.

Note also that `effect_event` is one of three outcomes meaning *keep the effect*, so it never
produces a finding. Sharpening it stops an effect that legitimately uses your hook from being
mistaken for one to delete. `data_library` reports, so overriding it changes a finding you see.
Both are worth doing; only one is visible.

Overriding is not free: the model weighs all fifteen outcomes against each other and the
thresholds were measured against the built-in wording, which is why hugaw prints that line on
startup. [docs/internals.md](docs/internals.md#calibration) has the measurements.

To go further than configuration — a new rule, a new slice of context, or a new option for the
effect rule — [docs/internals.md](docs/internals.md) has the walkthroughs, including the rule
that every threshold must come from a live ablation before it ships.

## Next

- [docs/usage.md](docs/usage.md) — flags, config, CI, cost, reading a finding
- [docs/internals.md](docs/internals.md) — architecture, the slices, and the calibration record
- [sample/](sample/) — the same file through hugaw and through
  `eslint-plugin-react-you-might-not-need-an-effect`, side by side
