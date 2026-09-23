import { defineConfig } from "hugaw";
import react from "hugaw/react";

/**
 * The same sample, with two of the effect rule's criteria replaced.
 *
 * `external_store` overrides the criterion only, keeping the built-in fix.
 * `data_library` overrides both, because a criterion that talks about this
 * project's generated hooks while the message still says "the project's
 * data-fetching hook" tells the reader something the model never read.
 */
export default defineConfig({
  // Pointed at the fixtures rather than at `src/`, because the override needs
  // a `data_library` finding to bite on and `src/` is the side-by-side
  // comparison file, not a demo of config.
  files: ["fixtures/useeffect-alternatives/should-warn/fetch-cross-file.tsx"],
  ignores: ["**/node_modules/**", "**/_*.ts"],
  model: "jev-1.13.0",
  plugins: [react],
  rules: {
    "react/pointless-usememo": "off",
    "react/useeffect-alternatives": [
      "error",
      {
        extends: {
          replacements: {
            external_store:
              "Replace the state and the effect with `useSyncExternalStore`. The effect subscribes to a browser API only to mirror its current value into React state. Evidence: a listener in `effect_body` and a `state-setter` called inside it. Not `keep_effect`: this copies a value rather than accumulating events.",
            data_library: {
              criterion:
                "Replace the effect and the state it fills with this codebase's generated `useXQuery` hook. Every query here has one generated from the schema, and it handles cancellation, races, dedup and caching, which a hand-written effect does not. Evidence: a call to `fetch`, an HTTP client, or a `.then` whose callback is a `state-setter`, with dependencies that are ids or query variables. Not `lift_fetch`: the data is consumed here rather than passed up. Not `keep_effect`: a network read that fills state is exactly the job the generated hook exists for.",
              fix: "replace the effect with the generated `useXQuery` hook for this request, and delete {state}",
            },
          },
        },
      },
    ],
  },
});
