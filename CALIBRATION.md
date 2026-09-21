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
| 1 | websocket chat room | `keep_effect` | 0.98 | **0.98** | external_store 0.02 | 0.44 | 0.93 |
| 2 | online/offline mirror (SKILL.md §11) | `external_store` | 0.97 | **0.03** | mount_effect 0.02 | 0.28 | 0.61 |
| 3 | setInterval clock | `keep_effect` | 0.74 | **0.94** | mount_effect 0.20 | 0.40 | 0.85 |
| 4 | derived state (SKILL.md §1) | `render_computation` | 1.00 | **0.00** | — | 0.11 | 0.03 |
| 5 | selection reset on `[items]` (SKILL.md §6) | `derive_by_id` | 0.96 | **0.00** | key_prop 0.04 | 0.12 | 0.03 |
| 6 | profile reset on `[userId]` (SKILL.md §5) | `key_prop` | 0.98 | **0.00** | use_linked_state 0.01 | 0.12 | 0.03 |
| 7 | LikeButton flag (SKILL.md §4) | `event_handler` | 1.00 | **0.00** | — | 0.14 | 0.10 |
| 8 | notify parent of a toggle (SKILL.md §8) | `notify_parent` | 1.00 | **0.00** | — | 0.14 | 0.06 |
| 9 | child bubbles query data up (SKILL.md §9) | `lift_fetch` | 0.94 | **0.05** | effect_event 0.04 | 0.20 | 0.06 |
| 10 | fetch on id change, callee cross-file (SKILL.md §3) | `data_library` | 0.95 | **0.04** | keep_effect 0.04 | 0.19 | 0.14 |
| 11 | auth from storage on `[]` (SKILL.md §10) | `module_init` | 1.00 | **0.00** | — | 0.14 | 0.26 |
| 12 | ResizeObserver on `[]`, writes width to state (SKILL.md §12) | `external_store` | 0.68 | **0.32** | mount_effect 0.20 | 0.49 | 0.87 |
| 13 | `document.title` on `[title]` | `keep_effect` | 0.99 | **0.99** | render_computation 0.01 | 0.17 | 0.38 |
| 14 | effect inside a custom hook — no parent, no props | `notify_parent` | 0.95 | **0.04** | keep_effect 0.02 | 0.16 | 0.07 |
| 15 | no dependency array at all | `keep_effect` | 0.96 | **1.00** | mount_effect 0.04 | 0.21 | 0.80 |
| 16 | `async` callback with `.then(setX)` | `data_library` | 0.93 | **0.05** | keep_effect 0.05 | 0.18 | 0.13 |
| 17 | third-party widget on `[]`, no state written *(control for 12)* | `mount_effect` | 0.65 | **0.99** | keep_effect 0.33 | 0.46 | 0.92 |

~4,600 input tokens per case, 78,675 for the run = **$0.0033**. Five runs across three payload
revisions and two criteria revisions gave the same mode on all 17 cases, so these numbers are
reproducible rather than a single sample. Run-to-run drift is within 0.03 except where noted
under case 12 below.

> **Re-measured 2026-09-21** after `use_linked_state` was added and `derive_by_id` rewritten.
> The table above is the post-rewrite run; see "Editable state that follows a prop" below for
> the before/after and for the one number that moved materially.

### The thresholds, and the measurement behind each

**`KEEP_FAMILY_MASS_MAX = 0.5`** — the gate. Sorted, the keep-family mass is:

```
must be deleted (12)   0.00 ×6   0.03   0.04 ×2   0.05 ×2   0.32          ← max 0.32
must be kept     (5)                          0.94   0.98   0.99 ×2   1.00   ← min 0.94
```

The six zeros are cases 4, 5, 6, 7, 8 and 11; the 0.32 is case 12, discussed below. Nothing
lands between 0.32 and 0.94. 0.5 sits 0.18 above the highest delete and 0.44 below the lowest
keep, and every one of the 17 cases falls on the correct side. By analogy with
`UNBOUNDED_WORK_MASS_MIN`, which is the same shape of decision on the memo rule.

**`EITHER_OR_MIN = 0.10`** — when the runner-up's fix is printed as an alternative. The
largest delete-family runner-up in the table is 0.03; the largest of any kind is `keep_effect`
at 0.34 on case 17, which prints as a caveat rather than as an alternative. Before the
criteria split the delete-family maximum was `key_prop` at 0.13 on case 5, which is the case
this threshold was set from; sharper criteria have made every distribution more one-sided, so
the bar now fires less often than when it was chosen. The plan's guessed 0.25 would have fired twice in seventeen, both times on a keep-family
runner-up, which prints as a caveat rather than an alternative — i.e. never where an
alternative fix is useful.

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

**One number moved materially.** Case 12's keep-family mass went from 0.17 to 0.32 (0.35 and
0.32 on two runs, so it is real and not drift), halving the clearance below the gate from 0.33
to 0.18. Its mode is unchanged and still correct. Case 12 is the case already documented below
as genuinely ambiguous, and it is the one most sensitive to a change in the menu — adding a
fourteenth option redistributes mass everywhere, and it lands hardest where the model was least
certain to begin with. The threshold is unchanged: 0.18 of clearance below and 0.44 above is
still a gap with nothing in it, and no case changed mode. It is recorded here because the next
option added to this Choice should re-measure case 12 first.

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
