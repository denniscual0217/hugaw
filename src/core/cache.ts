import { createHash } from "node:crypto"
import type { JsonValue } from "./json.js"
import { stableStringify } from "./json.js"
import type { JudgeRequest, JudgeResponse } from "./judge.js"

export interface Cache {
  get(key: string): Promise<JudgeResponse | undefined>
  set(key: string, value: JudgeResponse): Promise<void>
}

/** MVP ships the seam, not the feature (SPEC §7). */
export const noopCache: Cache = {
  async get() {
    return undefined
  },
  async set() {
    /* no-op */
  },
}

/** Deterministic: sorted keys, request id excluded (it carries a file offset). */
export function cacheKey(req: JudgeRequest): string {
  const payload = stableStringify({
    model: req.model,
    state: req.state,
    questions: req.questions as unknown as JsonValue,
  })
  return createHash("sha256").update(payload).digest("hex")
}
