import type {
  Facts,
  LanguageAdapter,
  LanguageTypes,
  Plugin,
  Rule,
} from "./types.js"
import type { QuestionSet } from "./questions.js"

/** Slice names appear verbatim inside question text, so they must read as identifiers. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export function defineRule<T extends LanguageTypes, D, Q extends QuestionSet, F extends Facts>(
  rule: Rule<T, D, Q, F>,
): Rule<T, D, Q, F> {
  if (!rule.name) throw new TypeError("defineRule: `name` is required")
  if (rule.name.includes("/")) {
    throw new TypeError(`defineRule: rule name "${rule.name}" must not contain "/" (the plugin id supplies it)`)
  }
  return rule
}

export function definePlugin<T extends LanguageTypes>(plugin: Plugin<T>): Plugin<T> {
  if (!plugin.id) throw new TypeError("definePlugin: `id` is required")
  if (!plugin.language) throw new TypeError(`definePlugin: plugin "${plugin.id}" needs a \`language\``)

  for (const name of Object.keys(plugin.slices)) {
    if (!IDENTIFIER.test(name)) {
      throw new TypeError(
        `definePlugin: slice name "${name}" in plugin "${plugin.id}" is not a valid identifier`,
      )
    }
  }

  const known = new Set(Object.keys(plugin.slices))
  for (const rule of plugin.rules) {
    for (const slice of rule.context) {
      if (!known.has(slice)) {
        throw new TypeError(
          `definePlugin: rule "${plugin.id}/${rule.name}" declares context slice "${slice}" ` +
            `which plugin "${plugin.id}" does not provide (has: ${[...known].join(", ") || "none"})`,
        )
      }
    }
  }
  return plugin
}

export function defineAdapter<T extends LanguageTypes, O>(
  adapter: LanguageAdapter<T, O>,
): LanguageAdapter<T, O> {
  if (!adapter.id) throw new TypeError("defineAdapter: `id` is required")
  if (adapter.extensions.length === 0) {
    throw new TypeError(`defineAdapter: adapter "${adapter.id}" must declare at least one extension`)
  }
  return adapter
}

export function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== "object" || value === null) return false
  const v = value as Partial<Plugin>
  return (
    typeof v.id === "string" &&
    typeof v.language === "string" &&
    Array.isArray(v.rules) &&
    typeof v.slices === "object" &&
    v.slices !== null
  )
}

export function isAdapter(value: unknown): value is LanguageAdapter {
  if (typeof value !== "object" || value === null) return false
  const v = value as Partial<LanguageAdapter>
  return (
    typeof v.id === "string" &&
    Array.isArray(v.extensions) &&
    typeof v.parseOptions === "function" &&
    typeof v.load === "function"
  )
}
