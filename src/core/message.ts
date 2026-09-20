import type { Facts, RuleOptions, Verdict } from "./types.js"

/** Replaces `{factName}` with the fact's value; unknown names are left untouched. */
export function interpolate(template: string, facts: Facts): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => {
    if (!Object.hasOwn(facts, key)) return whole
    const value = facts[key]
    if (value === null) return "null"
    if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value)
    return String(value)
  })
}

/**
 * Config-level `message` overrides the rule's message entirely;
 * `messageSuffix` is then appended with a single space (SPEC §5).
 */
export function applyMessageOptions(verdict: Verdict, options: RuleOptions | undefined): string {
  let message = verdict.message
  const override = options?.message
  if (typeof override === "string") {
    message = interpolate(override, verdict.facts)
  } else if (typeof override === "function") {
    message = override(verdict.facts)
  }
  const suffix = options?.messageSuffix
  if (suffix !== undefined && suffix.length > 0) message = `${message} ${suffix}`
  return message
}
