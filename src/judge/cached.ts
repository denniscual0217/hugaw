import type { Cache, Judge, JudgeRequest, JudgeResponse } from "../core/index.js"
import { cacheKey } from "../core/index.js"

/**
 * Wraps a judge in a cache. The runner also consults its own cache, so this
 * exists for callers that use a judge directly (and for when `Cache` grows a
 * real on-disk implementation — SPEC §7).
 */
export function withCache(judge: Judge, cache: Cache): Judge {
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse | null> {
      const key = cacheKey(request)
      const hit = await cache.get(key)
      if (hit !== undefined) return hit
      const response = await judge.judge(request)
      if (response !== null) await cache.set(key, response)
      return response
    },
  }
}
