# Calibration — live run against jev-1.13.0

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

## Findings that affect implementation

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

## Expected fixture values
Use these as the mocked judge's canned answers so unit tests are deterministic, and keep the
live run behind `HUGAW_LIVE=1`.
