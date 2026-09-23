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
$ hugaw fixtures/pointless-usememo/should-warn/constant-object.tsx
fixtures/pointless-usememo/should-warn/constant-object.tsx
  8:17  warning  This useMemo does nothing. The computation is constant work and `label` is only read at line 9. Inline the expression and remove the dep array.  react/pointless-usememo

✖ 1 problem (0 errors, 1 warning)
1 candidates, 0 skipped statically, 1 judged · 853 tokens · <$0.0001 @ $0.042/M
```

Every run reports what it spent. Output is ESLint-compatible: `--format json` is ESLint's
`LintResult[]` verbatim, and exit codes match. See [docs/usage.md](docs/usage.md) for flags,
CI output, and what to do when a finding looks wrong.

## The rules

**`react/pointless-usememo`** reports a `useMemo` whose computation is cheap *and* whose value
no consumer compares by reference. Both halves need context a static rule does not have: the
cost depends on what the called function does, and the identity question depends on where the
value ends up.

That is the finding above; this is the whole file it came from. `format` is resolved and
inlined into the request, which is how the model tells constant work from a nested loop:

```tsx
import { useMemo } from "react"

function format(amount, currency) {
  return `${currency}${amount.toFixed(2)}`
}

export function Price({ amount, currency }) {
  const label = useMemo(() => ({ text: format(amount, currency) }), [amount, currency])
  return <span className="price">{label.text}</span>
}
```

**`react/useeffect-alternatives`** reports a `useEffect` that a React primitive would do
better — derived state, an event handler, a `key`, `useSyncExternalStore`, a data-fetching
hook, a ref callback, module scope — and stays quiet when the effect is genuine
synchronisation.

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

It will not tell you to delete a WebSocket subscription. Which outcomes it can report, and the
measurements behind every threshold, are in
[docs/internals.md](docs/internals.md#calibration).

## Configuring it

`hugaw.config.ts` in your project root:

```ts
import { defineConfig } from "hugaw"
import react from "hugaw/react"

export default defineConfig({
  files: ["src/**/*.{ts,tsx}"],
  plugins: [react],
  rules: {
    "react/pointless-usememo": "warn",
    "react/useeffect-alternatives": ["error", { context: "This app renders 10k-row tables." }],
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

To go further than configuration — a new rule, a new slice of context, or a new option for the
effect rule — [docs/internals.md](docs/internals.md) has the walkthroughs, including the rule
that every threshold must come from a live ablation before it ships.

## Next

- [docs/usage.md](docs/usage.md) — flags, config, CI, cost, reading a finding
- [docs/internals.md](docs/internals.md) — architecture, the slices, and the calibration record
- [sample/](sample/) — the same file through hugaw and through
  `eslint-plugin-react-you-might-not-need-an-effect`, side by side
