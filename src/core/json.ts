/**
 * The JSON subset hugaw threads from slice extractors to the judge wire format.
 * Core never inspects the contents; it only guarantees serialisability.
 */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** Throws if `value` is not JSON-serialisable. Used at the slice boundary. */
export function assertJson(value: unknown, what: string): asserts value is JsonValue {
  const seen = new WeakSet<object>()
  const walk = (v: unknown, path: string): void => {
    if (v === null) return
    const t = typeof v
    if (t === "string" || t === "number" || t === "boolean") {
      if (t === "number" && !Number.isFinite(v as number)) {
        throw new TypeError(`${what}${path} is not JSON-serialisable: ${String(v)}`)
      }
      return
    }
    if (t !== "object") {
      throw new TypeError(`${what}${path} is not JSON-serialisable: ${t}`)
    }
    const obj = v as object
    if (seen.has(obj)) throw new TypeError(`${what}${path} is circular`)
    seen.add(obj)
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    for (const [k, item] of Object.entries(obj)) walk(item, `${path}.${k}`)
  }
  walk(value, "")
}

/** Deterministic stringify with sorted object keys — the basis of the cache key. */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`)
    .join(",")
  return `{${body}}`
}
