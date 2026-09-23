# sample

The same file through both tools, so the difference is visible rather than argued.

```sh
npm install
npm run eslint              # eslint-plugin-react-you-might-not-need-an-effect, all 9 rules, at error
npm run hugaw               # hugaw, react/useeffect-alternatives only
npm run compare             # both, one after the other
```

`npm run hugaw` needs `TYPESAFE_API_KEY` in the environment or in a `.env` beside it. It
reports what it spent on its own stats line, so there is no figure to keep up to date here:

```
6 candidates, 0 skipped statically, 6 judged · 26.6k tokens · $0.0011 @ $0.042/M
```

## What `src/sample.tsx` is for

Six effects. Five should be reported and one should not, and in every reported case the work
that makes the effect wrong happens **inside a helper function**, not in the effect body. That
is the shape a rule reading one syntax tree cannot follow.

Measured output, both tools, 2026-09-24:

```
eslint-plugin-react-you-might-not-need-an-effect  (all 9 rules, at error)

  54:9  error  Avoid using state and effects as an event handler. Instead, call the event
               handling code directly when the event occurs  ymnne/no-event-handler

✖ 1 problem (1 error, 0 warnings)
```

```
hugaw  react/useeffect-alternatives

  16:3  error  This effect calls `syncUser()`. Compute it during render (use `useMemo` if the work is expensive) and delete the effect.
  33:3  error  This effect calls `evaluateCount(count)`, which sets `finished`. Compute the whole next state in the handler that sets `count` and delete the effect. Or compute it during render and delete the state and the effect.
  53:3  error  This rule cannot describe what this effect does. Do that work in the handler that sets `status` and delete the effect. The effect's writes could not be resolved. Verify before removing.
  69:3  error  This effect calls `updateName()`, which sets `fullName`. Compute it during render (use `useMemo` if the work is expensive) and delete the state and the effect.
  85:3  error  This effect calls `performSubmission()`, which calls `submitOrder()`. Do that work in the handler that sets `shouldSubmit` and delete the effect.

✖ 5 problems (5 errors, 0 warnings)
```

| component | what it is | ESLint plugin | hugaw |
|---|---|---|---|
| `UserCard` | helper calls a helper that sets state | silent | reports, names no state (below) |
| `Counter` | helper sets state | silent | reports, **names `finished`** |
| `Payment` | effect calls an object-literal method | reports (`no-event-handler`) | reports, says it cannot describe it |
| `Profile` | helper sets state | silent | reports, **names `fullName`** |
| `Checkout` | helper performs an outward action | silent | reports, **names `submitOrder()`** |
| `Presence` | WebSocket with a cleanup | silent (correct) | silent (correct) |

**`Counter`, `Profile` and `Checkout` are the case for the whole project.** The effect body is
one call to a local function; everything that decides the verdict is inside that function.
hugaw inlines the helper's body into the request, the model judges on it, and the message
follows the same one level so the sentence shows the evidence: *which sets `finished`*.

**`UserCard` is the honest limit.** `syncUser()` calls `updateDisplayName()`, and *that* sets
the state — two levels. hugaw inlines one body, so it reports the effect but names no state,
and the fix degrades to "delete the effect" rather than claiming a write it never saw.

**`Payment` is the one the ESLint plugin gets and hugaw does not describe.** The effect calls
`actions.complete()`, a method on an object literal, which hugaw does not resolve to a
function. It still reports, and says plainly that it could not describe the body.

**`Presence` is the one that matters most.** A WebSocket subscription with a cleanup is a
legitimate effect, and a tool that tells you to delete it is worse than no tool. Both are
silent.

## What this directory no longer shows

There used to be a cross-file pair here — the same computation with its callee in
`src/sample.tsx` and in `src/_lib.ts` — demonstrating that hugaw inlines a same-file body and
caveats a cross-file one. `src/sample.tsx` no longer imports anything but React, so
**`src/_lib.ts` is unused and that comparison is not in this directory any more**. The
behaviour it showed is still real and still tested; see
`fixtures/useeffect-alternatives/should-warn/fetch-cross-file.tsx`, whose finding carries
*`fetchProduct` is defined in another file and was not read.*
