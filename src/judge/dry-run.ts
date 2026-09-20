import type { Judge } from "../core/judge.js"

/**
 * The entire `--dry-run` short-circuit. Declining (returning null) makes the
 * runner record the request and skip `decide()`, so nothing in core — and
 * nothing in any rule — needs to know the flag exists.
 */
export const dryRunJudge: Judge = {
  async judge() {
    return null
  },
}
