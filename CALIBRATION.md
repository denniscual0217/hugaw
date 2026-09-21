# Calibration — live runs against jev-1.13.0

What is measured, and what is still a guess. Every threshold in `src/plugins/react/rules/**`
should be traceable to a row in this file; where it is not, the rule says so in a comment.

---

## `react/pointless-usememo`

> **Stale as of 2026-09-21.** Measured against the pre-2026-09-21 cost rubric; the
> verdicts still hold, but the score column predates the bounded/unbounded criteria.
> Do not re-derive thresholds from these numbers.

Run before implementation to validate the rule design. 6/6 correct.
Thresholds: `identity_matters > 0.4` → silent · `cost > 1.2` → silent · `confidence < 0.6` → silent

| case | scenario | cost | conf | identity | verdict | correct |
|---|---|---:|---:|---:|---|---|
| A | `` `${currency}${amount.toFixed(2)}` `` rendered in `<span>` | 0.00 | 1.00 | 0.08 | **WARN** | ✓ |
| B | `buildPivot(rows)`, callee source inlined (nested loops) | 2.00 | 1.00 | 0.10 | silent (cost) | ✓ |
| C | `buildPivot(rows)`, callee **unresolved** (cross-file) | 2.00 | 0.99 | 0.11 | silent (cost) | ✓ |
| D | `countRows(rows)`, callee source inlined (`rows.length`) | 0.11 | 0.89 | 0.08 | **WARN** | ✓ |
| E | `[...users].sort(...)` iterated in render | 2.00 | 1.00 | 0.12 | silent (cost) | ✓ |
| F | `({theme, locale})` passed as context `value` | 0.00 | 1.00 | 0.85 | silent (identity) | ✓ |

3,634 input tokens total = **$0.000153** for six judgments.

### Findings that affect implementation

**B vs D is the proof the `callee_sources` slice earns its keep.** Identical call shape,
opposite verdict (2.00 vs 0.11), decided purely by the inlined callee body. Fixtures must
cover both.

**C got the right answer for a possibly wrong reason.** With the body unresolved, the model
inferred expense from the *name* `buildPivot`. Right here, but name-based inference is not
reliable — a cross-file `formatLabel` would likely be judged cheap and could produce a false
WARN. This is exactly why `unresolved` must drive the caveat clause. Do not treat C as
evidence that the digest pass is unnecessary.

**Confidence is consistently high (0.89–1.00).** The `MIN_CONFIDENCE = 0.6` gate almost never
fires at these thresholds. Keep it — it is cheap insurance — but do not expect it to be load-bearing.

**F is caught twice**, by `skip` (context value) and by `identity_matters` 0.85. Belt and
braces is correct: `skip` makes it free, the model makes it safe if `skip` misses a variant.

### Expected fixture values
Use these as the mocked judge's canned answers so unit tests are deterministic, and keep the
live run behind `HUGAW_LIVE=1`.

---

## `react/useeffect-alternatives`

Run before `decide` existed, over 17 synthetic cases, and it changed the rule's shape: the
design shipped with **one question instead of two**. Reproduce with
`HUGAW_LIVE=1 npx vitest run test/effect-ablation.live.test.ts`, which also asserts the gate.

The sixteen cases are the plan's; case 17 is a control added when case 12 turned out to be
confounded (below). Sources are synthetic — the target repository is an employer's codebase
and was not sent to the API.

`keepFam` is the summed mass of `keep_effect + mount_effect + effect_event`. `noul¹` and
`noul²` are two wordings of a second question that was measured and then **deleted**; they are
kept in the ablation file so this table can be re-derived, and nowhere else.

| # | case | mode | mass | keepFam | runner-up | noul¹ | noul² |
|---|---|---|---:|---:|---|---:|---:|
| 1 | websocket chat room | `keep_effect` | 0.99 | **0.99** | external_store 0.01 | 0.48 | 0.93 |
| 2 | online/offline mirror (SKILL.md §11) | `external_store` | 0.98 | **0.02** | mount_effect 0.02 | 0.29 | 0.65 |
| 3 | setInterval clock | `mount_effect` | 0.50 | **0.93** | keep_effect 0.43 | 0.40 | 0.84 |
| 4 | derived state (SKILL.md §1) | `render_computation` | 1.00 | **0.00** | — | 0.10 | 0.02 |
| 5 | selection reset on `[items]` (SKILL.md §6) | `derive_by_id` | 0.92 | **0.00** | key_prop 0.07 | 0.12 | 0.02 |
| 6 | profile reset on `[userId]` (SKILL.md §5) | `key_prop` | 0.99 | **0.00** | derive_by_id 0.01 | 0.13 | 0.03 |
| 7 | LikeButton flag (SKILL.md §4) | `event_handler` | 1.00 | **0.00** | — | 0.14 | 0.10 |
| 8 | notify parent of a toggle (SKILL.md §8) | `notify_parent` | 1.00 | **0.00** | — | 0.13 | 0.06 |
| 9 | child bubbles query data up (SKILL.md §9) | `lift_fetch` | 0.89 | **0.10** | effect_event 0.08 | 0.20 | 0.06 |
| 10 | fetch on id change, callee cross-file (SKILL.md §3) | `data_library` | 0.96 | **0.04** | keep_effect 0.04 | 0.18 | 0.13 |
| 11 | auth from storage on `[]` (SKILL.md §10) | `module_init` | 0.99 | **0.01** | mount_effect 0.01 | 0.14 | 0.27 |
| 12 | ResizeObserver on `[]`, writes width to state (SKILL.md §12) | `external_store` | 0.65 | **0.35** | mount_effect 0.31 | 0.50 | 0.86 |
| 13 | `document.title` on `[title]` | `keep_effect` | 0.97 | **0.97** | render_computation 0.03 | 0.18 | 0.40 |
| 14 | effect inside a custom hook — no parent, no props | `notify_parent` | 0.93 | **0.05** | keep_effect 0.03 | 0.16 | 0.06 |
| 15 | no dependency array at all | `keep_effect` | 0.97 | **1.00** | mount_effect 0.03 | 0.24 | 0.80 |
| 16 | `async` callback with `.then(setX)` | `data_library` | 0.96 | **0.04** | keep_effect 0.04 | 0.18 | 0.13 |
| 17 | third-party widget on `[]`, no state written *(control for 12)* | `mount_effect` | 0.72 | **0.97** | keep_effect 0.24 | 0.46 | 0.92 |
| 18 | focus a conditionally rendered input (the Modal shape) | `ref_callback` | 0.98 | **0.02** | keep_effect 0.02 | 0.26 | 0.85 |
| 19 | focus an always-mounted input, keyed to another prop | `keep_effect` | 0.85 | **0.85** | ref_callback 0.14 | 0.23 | 0.79 |
| 20 | scroll a conditionally rendered node into view | `ref_callback` | 0.75 | **0.25** | keep_effect 0.25 | 0.23 | 0.78 |
| 21 | measure a node on mount and store the width | `keep_effect` | 0.69 | **0.73** | ref_callback 0.15 | 0.21 | 0.38 |
| 22 | cascading state, first effect (`count` -> `isTen`) | `render_computation` | 0.53 | **0.01** | collapse_to_handler 0.46 | 0.13 | 0.02 |
| 23 | cascading state, second effect (`isTen` -> `message`) | `collapse_to_handler` | 0.58 | **0.01** | render_computation 0.41 | 0.12 | 0.02 |

~4,770 input tokens per case, 109,813 for the run = **$0.0046**. The run is now 23 cases: the
plan's 16, the mount control (17), four for `ref_callback` (18–21) and the two links of one
state chain (22–23).

> **Re-measured 2026-09-22**, twice over, for two changes made together: the `ref_callback`
> option was added, and the Choice's instructions stopped telling the model to read a
> `contrast` field that the criteria have not had since they collapsed to strings. Both move
> the payload. The instruction fix mattered more than expected — case 12 read 0.44–0.50 while
> the prompt named a missing field, and 0.35 once it did not.

### The thresholds, and the measurement behind each

**`KEEP_FAMILY_MASS_MAX = 0.5`** — the gate. Sorted, the keep-family mass is:

```
must be deleted (16)   0.00 ×5   0.01 ×3   0.02 ×2   0.04 ×2   0.05   0.10   0.25   0.35          ← max 0.35
must be kept     (7)   0.73   0.85   0.93   0.97 ×2   0.99   1.00   ← min 0.73
```

Nothing lands between 0.35 and 0.73. 0.5 sits 0.15 above the highest delete and 0.23 below
the lowest keep, and every case falls on the correct side. By analogy with
`UNBOUNDED_WORK_MASS_MIN`, which is the same shape of decision on the memo rule.

**`EITHER_OR_MIN = 0.10`** — when the runner-up's fix is printed as an alternative. The
largest runner-up in the table is `collapse_to_handler` at 0.46 on case 22, which is the
genuine near-tie this threshold exists for: a chain whose first link is also a plain
derivation. The next are 0.25 (case 12) and 0.24 (case 17). The plan's guessed 0.25 would
have fired on one case in twenty-three.

There are no other thresholds. The rule has no confidence gate: `choice.confidence` is carried
in facts so it can be ablated later, and low confidence *between two delete outcomes* is still
certainty that the effect should go.

### Why the second question was deleted

The plan gated on a Noul asking whether the effect was a genuine synchronisation with an
external system. Two wordings were measured — `noul¹` restructured both sides around a single
axis, `noul²` is the plan's enumerating original — and neither can gate:

| signal | effects that must go | effects that must stay |
|---|---|---|
| keep-family mass | ≤ 0.17 | ≥ 0.92 |
| `noul¹` | 0.10 – 0.47 | 0.16 – 0.48 |
| `noul²` | 0.03 – 0.87 | 0.41 – 0.93 |

Both overlap. Under `noul¹`, `document.title` — an effect that must stay — scores 0.16,
*below* the online/offline mirror at 0.26, which must go. Under `noul²` the online/offline
mirror scores 0.63, high enough to suppress the very finding SKILL.md §11 exists to produce.

The Choice was carrying the signal the whole time, and reading only its mode threw it away.
Deleting the question removed roughly half the question tokens, three of the four guessed
constants (`JUSTIFIED_MAX`, `JUSTIFIED_CAVEAT_MIN`, `MOUNT_JUSTIFIED_MIN`), and the rule for
what to do when two questions disagree.

One consequence worth recording: the concern that a Noul phrased as a checklist would make
`module_init` unreachable did not survive contact with the numbers. Case 11 scores 0.29 under
`noul²` — already on the unjustified side of any sane threshold.

### Editable state that follows a prop — the `use_linked_state` split

`sample/src/sample.tsx` case 3 is editable state seeded from a prop:

```tsx
const [name, setName] = useState("")
useEffect(() => { setName(user.name) }, [user.id])
return <input value={name} onChange={(e) => setName(e.target.value)} />
```

It measured `derive_by_id` 0.56 / `render_computation` 0.27. **Both are breaking advice** —
`name` is editable, and computing or deriving it during render deletes the user's ability to
type. The option that fits, `use_linked_state`, was not on the menu at all: it had been dropped
earlier in favour of `derive_by_id` on the evidence of cases 5 and 6, neither of which is
editable in this way.

**The handler write does not separate the two.** Both this case and case 5 have identical
`writes` shapes — an `effect` entry and a `handler` entry:

```
case 3   [["effect", "user.name"], ["handler", "e.target.value"]]
case 5   [["effect", "null"],      ["handler", "i"]]
```

What separates them is the **argument of the effect's write**: case 3 seeds the state *from the
source*, case 5 *clears* it to a constant. That is the fact each criterion now names from its
own side, and it is why `derive_by_id` works for case 5 — a choice can be kept as an id and
looked up again, where free-typed text cannot be reconstructed from any id.

| | before | after |
|---|---|---|
| case 3 | `derive_by_id` 0.56, `render_computation` 0.27, `use_linked_state` **absent** | `use_linked_state` **0.99**, `render_computation` 0.01 |
| case 5 | `derive_by_id` 0.89, `key_prop` 0.11 | `derive_by_id` **0.96**, `key_prop` 0.04 |
| case 6 | `key_prop` 0.99, `derive_by_id` 0.01 | `key_prop` 0.98, `use_linked_state` 0.01 |

Case 5 improved rather than degrading, which is the check that mattered: the neighbour whose
mass the new option was most likely to take instead got sharper.

**One number moved materially.** Case 12's keep-family mass went from 0.17 to the 0.32–0.35
band (four runs since, so it is real and not drift), cutting the clearance below the gate from
0.33 to 0.15. Its mode is unchanged and still correct. Case 12 is the case already documented below
as genuinely ambiguous, and it is the one most sensitive to a change in the menu — adding a
fourteenth option redistributes mass everywhere, and it lands hardest where the model was least
certain to begin with. The threshold is unchanged: 0.18 of clearance below and 0.44 above is
still a gap with nothing in it, and no case changed mode. It is recorded here because the next
option added to this Choice should re-measure case 12 first — and the criteria collapse, which
changed the payload's shape without changing a word, moved it no further than its own
run-to-run band.

### Case 12 is not a miss

Case 12 — a `ResizeObserver` on empty deps that writes the measured width into state — comes
back `external_store` 0.83 with `mount_effect` at 0.10, and the rule reports it. **That is the
right answer.** An effect whose whole job is to mirror an external value into React state is
what `useSyncExternalStore` is for, and the observer being set up on mount does not change
that. The case cannot set a mount threshold because the two options are competing on merit.

Case 17 is the same shape with the confound removed: a third-party editor owned for the
instance's lifetime, no state written, nothing to mirror. It returns `mount_effect` 0.65 with
keep-family mass 0.99 — the `wrapMountEffect` finding, from the mode and the mass, with no
third threshold needed.

`should-warn/mount-sync-empty-deps.tsx` is case 17's shape for this reason. It was first
written as case 12's — a `ResizeObserver` writing to the DOM on mount — and measured
`keep_effect` 0.52 / `mount_effect` 0.35 / `effect_event` 0.10: keep-family mass 0.97, but the
mode is `keep_effect`, so the rule stayed silent and the fixture sat in `should-warn` reporting
nothing. As shipped it measures `mount_effect` 0.64 / `keep_effect` 0.33. A fixture in the
warning bucket that is silent against the live model is the mislabelling the buckets exist to
prevent, so the rule was not changed to accommodate it — the fixture was replaced with one the
model actually judges that way.

### Other findings

**Case 2 is why `wrapMountEffect` requires the mode and not just the mass.** SKILL.md's
canonical `useSyncExternalStore` example has empty dependencies, a cleanup, and listeners —
`mount_effect`'s stated evidence, verbatim. It puts 0.01 on `mount_effect`. Gating that
finding on evidence rather than on the model's own choice would tell a reader to do the
opposite of the skill.

**Case 7 settles the two criteria that overlap by construction.** SKILL.md's LikeButton does
`postLike(); setLiked(false)` — an outward action *and* a state update, matching
`event_handler` and `collapse_to_handler` at once. With the contrast text saying that the
outward action decides, it returns `event_handler` 1.00 and `collapse_to_handler` 0.00.

**Cases 5 and 6 settle `derive_by_id`.** The plan proposed a `useLinkedState` hook; SKILL.md §6
answers the same question with *store the id, derive during render*. The option now says what
the skill says, and the pair discriminates cleanly in both directions: 0.87/0.13 on case 5,
0.99/0.01 inverted on case 6.

**Case 9 is what the hook name in `hookResults` buys.** `onFetched(data)` where `data` came
from `useGetProductQuery` returns `lift_fetch` 0.93 with `data_library` at 0.00. A bare list
of binding names could not tell that `data` from a query differs from `data` from a toggle.

**Case 10: an unresolved cross-file callee does not inflate the judgment.** It sits at the
bottom of the delete band (keep-family 0.01) — the opposite direction to the memo rule's
case C, and the reason the caveat exists rather than a suppression.

**Cases 14–16 were open questions and are now answered.** An effect in a custom hook with no
parent returns `notify_parent` 0.91 — the Choice's instructions say that "the parent" means
the hook's caller, and it lands. An effect with no dependency array at all — a shape no option
describes — returns `keep_effect` 0.96, i.e. the model declines rather than guesses. An
`async` callback, where cleanup detection gives up and reports `hasCleanup: false`, still
returns `data_library` 0.97.
