# sample/ — ESLint vs hugaw, same file

**This is not the vitest suite.** That is `../test/`, and `pnpm test` from the repo
root does not glob this directory (nor does `tsconfig.json`). This directory has its
own `package.json` and its own `node_modules` so the ESLint plugin never becomes a
dependency of hugaw itself.

It exists to answer one question: on the same source, what does each tool find?

## Run it

```sh
cd sample && npm install     # once
npm run compare             # both tools, side by side
```

Or separately:

```sh
npm run eslint              # eslint-plugin-react-you-might-not-need-an-effect, all 9 rules, at error
npm run hugaw               # hugaw, react/useeffect-alternatives only
```

`npm run hugaw` needs `TYPESAFE_API_KEY` in the environment or in a `.env` beside it. It
reports what it spent on its own stats line, so there is no figure to keep up to date here:

```
5 candidates, 0 skipped statically, 5 judged · 21.5k tokens · $0.0009 @ $0.042/M
```

## What `src/sample.tsx` is for

Five effects, each chosen because it separates the two tools. Measured output as of
2026-09-21:

| # | component | ESLint plugin | hugaw |
|---|---|---|---|
| 1a | `TotalsInline` | reports (+ a spurious `no-pass-data-to-parent`) | reports |
| 1b | `TotalsImported` | **silent** | reports, and flags the unread callee |
| 2 | `ProductPage` | **silent** — no fetch rule exists | reports, names the data-library fix |
| 3 | `NameField` | reports, **advice would break it** | reports, **and keeps it editable** |
| 4 | `Presence` | silent (correct) | silent (correct) |

**1a versus 1b is the whole difference in two components.** Identical shape, identical
prop, identical setter — the only change is whether the value passes through an
imported function. A rule that reads one file has to go quiet there; hugaw inlines
same-file bodies into `effect_body.resolved` and reports cross-file ones as a blind
spot in the message.

**Case 2** is the canonical fetch-in-an-effect from the skill (races, no cancellation).
The plugin ships no rule for it: `no-derived-state` needs the setter's *arguments* to
trace back to props or state, and `.then(setProduct)` hands the setter over rather
than calling it.

**Case 3 is the honest one, and the reason this directory exists.** `name` is written
both in the effect and in the change handler, so "compute it during render" deletes the
user's ability to type. Both tools currently give breaking advice. hugaw carries the
deciding evidence in its payload —

```json
"writes": [
  { "line": 43, "within": "effect",  "argument": "user.name" },
  { "line": 46, "within": "handler", "argument": "e.target.value" }
]
```

— and picks the one fix that preserves it: `use_linked_state` at 0.99. It did not always.
This case originally returned `derive_by_id` 0.56 with `render_computation` behind it,
both of which delete the user's ability to type, and `use_linked_state` was not on the
menu at all. The signal was in the payload the whole time; what was missing was a
criterion that split on *what the effect writes* — a constant it clears, or a value
seeded from the source. See the Calibration section of `docs/internals.md`.

Bodies for 1b and 2 live in `src/_lib.ts` so the cross-file path is exercised.
