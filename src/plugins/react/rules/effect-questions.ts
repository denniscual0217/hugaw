import { choice } from "../../../core/index.js"

/**
 * The paid half of rule #2, kept in its own module so the live ablation can
 * import exactly what will ship without the rule being registered.
 *
 * Nothing here is a threshold and nothing here decides anything: these are the
 * two questions, and `decide` is written only once the ablation has said what
 * their answers look like on cases whose right answer we already know.
 */

/**
 * One option's criterion.
 *
 * A `type` alias rather than an `interface`, because an interface is not
 * assignable to core's index-signature `JsonObject` and these go on the wire.
 *
 * Three fields instead of one paragraph because the third is what makes a
 * thirteen-way choice work at all: every option here is somebody's plausible
 * reading of the same effect, so each one has to say which neighbour it is
 * *not*, and on what evidence the neighbour would have won instead.
 */
export type Criterion = {
  readonly description: string
  readonly evidence: string
  readonly contrast: string
}

/**
 * Thirteen outcomes, ordered so the null hypothesis anchors the list: keep it,
 * then the families that delete it (derive, handler, fetch, store, out of
 * React), then the two that keep it in a different wrapper.
 *
 * Two structural decisions are recorded here rather than in the plan:
 *
 * **`render_computation` absorbed `use_memo`.** Both mean "delete the effect
 * and compute during render"; they differ only in whether the computation is
 * expensive enough to memoise, which is a cost question, not a question about
 * whether the effect should exist. Splitting them made one option's criterion
 * the *absence* of evidence for the other — and when both rules fire on one
 * unit the memo rule's calibrated `cost` score answers the cost half for free.
 *
 * **`use_linked_state` became `derive_by_id`.** SKILL.md §6 answers "adjust a
 * slice of state when a prop changes" with *store the id and derive the object
 * during render* — no new primitive, no new hook. The option now says what the
 * skill says.
 */
export const REPLACEMENTS = {
  keep_effect: {
    description:
      "Keep it as written. It synchronises something React does not own — a connection, a subscription that accumulates events, an imperative widget, a DOM measurement, focus or scroll, analytics, a timer that produces new information — and it must re-run when its dependencies change, because each dependency is a reason to re-synchronise.",
    evidence:
      "Handles in `effect_body.externals`, or a resolved callee that talks to a non-React system; usually a cleanup; and dependencies that name the thing being synchronised.",
    contrast:
      "Not `mount_effect`: this one has real dependencies and must re-run when they change. Not `effect_event`: every dependency here is a trigger, none is merely read for its latest value. Not `module_init`: this is tied to this instance being on screen and is undone when it leaves.",
  },
  render_computation: {
    description:
      "Delete the effect and the state it writes, and compute the value during render instead — plainly when it is cheap, inside `useMemo` when the transform is expensive enough to be worth memoising. Either way it is one render pass, with no stale frame and no loop hazard; which of the two is a question about cost, not about whether the effect should exist.",
    evidence:
      "A `state-setter` call in `effect_body.calls` whose `inputs` are props or state, with `nested` null, no externals, and that state written nowhere else in `component_state.state[].writes`.",
    contrast:
      "Not `derive_by_id`: nothing here is edited by the user between changes of its inputs, so the value is a pure function of them. Not `collapse_to_handler`: the written state is a function of the dependencies rather than a transition from its own previous value.",
  },
  derive_by_id: {
    description:
      "Delete the effect and the state it clears. It adjusts one slice of state when a prop changes — typically resetting a selection because the list changed. Keep only the id in state and derive the object during render (`const selection = items.find(i => i.id === selectedId) ?? null`): it is then correct in the same render, with no effect and no stale window.",
    evidence:
      "One `state-setter` called with a constant or an initial value, keyed on the prop or collection the value follows, and that same state also written in a handler (`component_state.state[].writes` with `within: \"handler\"`) — the user picks it, the prop change invalidates it.",
    contrast:
      "Not `key_prop`: only this one slice follows the prop, and every other state the component declares must survive the change. Not `render_computation`: the user writes this state directly too, so it is not a pure derivation — what gets derived is the object the stored id points at.",
  },
  key_prop: {
    description:
      "Delete it. It resets the state this component declares when an identity prop changes, which React does natively by remounting — pass `key={thatProp}` where the component is rendered and the state resets with no choreography at all.",
    evidence:
      "`state-setter` calls whose arguments are constants or the states' own initial values, covering every state the component declares in `component_state.state`, all keyed on one id-like dependency.",
    contrast:
      "Not `derive_by_id`: that adjusts a single slice while the rest persists; this one wipes the lot, which is what makes remounting the right instrument. Not `render_computation`: nothing is being computed, state is being cleared.",
  },
  event_handler: {
    description:
      "Delete it. The work belongs in the event handler that caused it: a user interaction set a flag or a value, the effect noticed on the next render, and the handler could have done the work directly — a POST, a notification, a navigation.",
    evidence:
      "The dependency is state written only within a handler, often tested for truthiness at the top of the effect, and the body performs an outward action: a call in `effect_body.calls` that is `imported`, `same-file`, `global` or `member` rather than a state-setter.",
    contrast:
      "Not `collapse_to_handler`: the outward action decides. A body that posts, navigates or notifies is this option even when it also resets the flag afterwards — the two together (`postLike(); setLiked(false)`) are the canonical shape of *this* option, not of the other. Not `notify_parent`: the callee is an external action, not a callback the parent passed in.",
  },
  collapse_to_handler: {
    description:
      "Delete it. It is one link in a chain where a state update triggers an effect that performs another state update. Compute the whole next state in the handler that starts the chain — one transaction, no cascading renders.",
    evidence:
      "Every call in `effect_body.calls` is a `state-setter`, the dependency is itself state, and that state is written in a handler or in another effect.",
    contrast:
      "Not `event_handler`: nothing here reaches outside React. If the body posts, navigates or notifies, that option wins even when this one also sets state. Not `render_computation`: the written state is a transition — an increment, a toggle, a reset-and-advance — rather than a function of the dependency.",
  },
  notify_parent: {
    description:
      "Delete it. It calls a callback prop to tell the parent that local state changed. Call the callback in the same handler that sets the state, with the next value, and the round trip through render disappears.",
    evidence:
      "A `prop-callback` call in `effect_body.calls` whose `inputs` are local state, with that state also written `within: \"handler\"`.",
    contrast:
      "Not `event_handler`: the callee is a callback supplied from outside, not an external side effect. Not `lift_fetch`: what travels up is this unit's own user state, not data fetched from a server.",
  },
  lift_fetch: {
    description:
      "Delete it and move the data fetching up. This component fetches — or receives query data — and hands it up through a callback prop, so data flows back up instead of down. The parent should own the query and pass the data down as a prop.",
    evidence:
      "A `prop-callback` call whose argument is a query hook's result: match the argument name against `component_state.hookResults`, whose `hook` field names the hook it came from, so `useGetProductQuery` is a query and `useToggle` is not. A fetch in this body whose result is passed up counts too.",
    contrast:
      "Not `notify_parent`: what goes up is server data, not user state, and the fix moves the *fetch* rather than the call. Not `data_library`: the fetch may already use a library hook — what is wrong here is the direction the data travels.",
  },
  data_library: {
    description:
      "Replace the effect and the state it fills with a data-fetching hook — a generated per-operation query hook, Apollo's `useQuery`, React Query, SWR. It fetches on mount and when an id changes, and the library handles cancellation, races, dedup and caching, which a hand-written effect does not.",
    evidence:
      "A call to `fetch`, an HTTP client or `client.query`, or a `.then` whose callback is a `state-setter` (visible in that call's `nested`), with dependencies that are ids or query variables.",
    contrast:
      "Not `lift_fetch`: the data is consumed here rather than passed up. Not `keep_effect`: a network read that fills state is precisely the job the library hook exists for, so 'it talks to the network' is not a reason to keep it.",
  },
  external_store: {
    description:
      "Replace the state and the effect with `useSyncExternalStore`. The effect subscribes to a browser API or a third-party store only to mirror its *current value* into React state, which the store hook reads directly and without tearing under concurrent rendering.",
    evidence:
      "`addEventListener`, `subscribe`, `.on(`, `matchMedia` or an observer in `effect_body`, a `state-setter` called `nested` inside the listener with the source's current value, and a cleanup that unsubscribes.",
    contrast:
      "Not `keep_effect`: the test is what the listener does with the event. Writing a *snapshot* of the source's current value is this option; *accumulating* events — appending messages, counting ticks, pushing onto a list — is not a snapshot and stays `keep_effect`. Not `mount_effect`: empty dependencies plus a cleanup is what this shape looks like too, so they are not evidence either way.",
  },
  module_init: {
    description:
      "Move it out of React. It performs one-time application initialisation — reading auth out of storage, configuring an SDK, setting a global — that should run once per page load, not once per mount and twice under StrictMode. Module scope, or a module-level guard flag.",
    evidence:
      "Empty dependencies, no cleanup, and calls that touch global singletons rather than anything from this unit's props, state or instance.",
    contrast:
      "Not `mount_effect`: this has nothing to do with this instance being on screen and nothing to tear down, whereas a mount effect is per instance and usually undoes itself. Not `keep_effect`: it does reach outside React, but not *because this component is rendered* — the give-away is that running it earlier, at import time, would be strictly better, where running a `keep_effect` at import time would be wrong.",
  },
  mount_effect: {
    description:
      "Keep it, but wrap it in a named mount-only hook of the shape `useMountEffect(effect)`. It genuinely synchronises with an external system once when this instance mounts, has empty dependencies by design and usually returns a cleanup; the named hook makes that intent explicit and puts the lint suppression in one place.",
    evidence:
      "`depsKind: \"empty\"`, a cleanup, and externals or resolved callees that set up a widget, observer, listener or connection for this instance.",
    contrast:
      "Not `keep_effect`: the dependency array is empty on purpose and nothing should re-run it. Not `module_init`: this is per instance and has a teardown. Not `external_store`: this effect drives something, rather than reading a value out of it into state.",
  },
  effect_event: {
    description:
      "Keep the effect, but extract the reads that should not re-trigger it into a stable event function that always sees the latest values (`useEffectEvent`). The effect correctly synchronises on one dependency yet lists — or must list, to satisfy the lint — another value it only reads, so it re-runs for no reason.",
    evidence:
      "Two or more dependencies where one is the trigger and another is only read inside the body; often an `eslint-disable` comment nearby, or a ref used to smuggle the latest value in.",
    contrast:
      "Not `keep_effect`: that one has no over-reactive dependency — every dep is a reason to re-synchronise. Not `event_handler`: the effect is still needed, and only a read moves out of it.",
  },
} as const satisfies Record<string, Criterion>

export type Replacement = keyof typeof REPLACEMENTS

/** The three outcomes that leave the effect in place. */
export const KEEP_FAMILY: ReadonlySet<string> = new Set([
  "keep_effect",
  "mount_effect",
  "effect_event",
])

/**
 * There is deliberately only one question.
 *
 * A second — a Noul asking whether the effect is a genuine synchronisation
 * with something outside React — was written, measured on 17 cases, and
 * deleted. It could not gate. Sorted by what each question actually
 * separated (CALIBRATION.md):
 *
 *     keep-family mass   deletes <= 0.18            keeps >= 0.95
 *     noul (restructured) deletes 0.11-0.29         keeps 0.16-0.48
 *     noul (enumerating)  deletes 0.03-0.63         keeps 0.38-0.94
 *
 * The Choice separates the two families by a gap with nothing in it. Both
 * Noul wordings overlap: under the first, `document.title` — an effect that
 * must stay — scored *below* the online/offline mirror, which must go.
 *
 * The signal was there the whole time and was being thrown away by reading
 * only the Choice's mode. Summing the mass of the three options that leave
 * the effect in place is the gate, and it costs nothing extra: no second
 * question on the wire, no third guessed threshold, and no rule for what to
 * do when two questions disagree.
 */
export const replacement = choice(
  "What should happen to the effect in `effect_call`? Pick the single best-fitting outcome. Use `effect_body` for what it calls and touches, `component_state` for which state it writes and where else that state is written, and `component_source` for the whole picture. Each option's `contrast` names the neighbour it is not and says what would have made that neighbour win. When `component_state.owner.kind` is `\"hook\"` the unit is a custom hook, not a component: \"the parent\" means the caller of the hook, and a `prop-callback` is an argument the caller passed in.",
  REPLACEMENTS,
)

export const effectQuestions = {
  replacement,
}

export type EffectQuestions = typeof effectQuestions
