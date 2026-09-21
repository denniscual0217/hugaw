import { z } from "zod"
import { isAdapter, isPlugin } from "./define.js"
import type {
  AnyRule,
  LanguageAdapter,
  LanguageTypes,
  NumericSeverity,
  Plugin,
  RuleOptions,
  Severity,
} from "./types.js"

const severitySchema = z.enum(["off", "warn", "error"])

const ruleOptionsSchema = z.object({
  // zod 4 dropped `z.function()` as a schema; a predicate keeps the runtime check honest.
  message: z
    .union([z.string(), z.custom<(facts: never) => string>((v) => typeof v === "function")])
    .optional(),
  messageSuffix: z.string().optional(),
  /** Free-text project context for this rule; reaches the model as `context`. */
  context: z.string().optional(),
})

const ruleSettingSchema = z.union([severitySchema, z.tuple([severitySchema, ruleOptionsSchema])])

/**
 * `looseObject` so adapter-owned keys (e.g. `tsconfig`) survive validation and
 * reach `adapter.parseOptions(raw)`. Core does not know those key names.
 */
export const configSchema = z.looseObject({
  files: z.array(z.string()).default(["**/*.{ts,tsx}"]),
  ignores: z.array(z.string()).default(["**/node_modules/**", "**/dist/**"]),
  model: z.string().default("jev-1.13.0"),
  /** Free-text project context for every rule. Rule-level context is appended to it. */
  context: z.string().optional(),
  plugins: z.array(z.custom<Plugin>(isPlugin, { message: "not a hugaw plugin" })).default([]),
  adapters: z
    .array(z.custom<LanguageAdapter>(isAdapter, { message: "not a hugaw language adapter" }))
    .optional(),
  rules: z.record(z.string(), ruleSettingSchema).default({}),
  // Placeholders — typed and validated, unused in the MVP (SPEC §7).
  cache: z
    .object({ enabled: z.boolean().default(true), dir: z.string().default(".hugaw-cache") })
    .optional(),
  limits: z.object({ maxRequests: z.number().int().positive().optional() }).optional(),
  resolve: z
    .object({
      digestDepth: z.number().int().optional(),
      knownHooks: z.array(z.string()).optional(),
    })
    .optional(),
})

export type HugawConfig = z.input<typeof configSchema>
export type ResolvedConfig = z.output<typeof configSchema> & {
  readonly raw: Record<string, unknown>
}

export function defineConfig(config: HugawConfig): HugawConfig {
  return config
}

/** Parse + attach the untouched raw object adapters read their options from. */
export function resolveConfig(raw: Record<string, unknown>): ResolvedConfig {
  const parsed = configSchema.parse(raw)
  return { ...parsed, raw }
}

export interface EnabledRule<T extends LanguageTypes = LanguageTypes> {
  readonly ruleId: string
  readonly rule: AnyRule<T>
  readonly plugin: Plugin<T>
  readonly severity: NumericSeverity
  readonly options: RuleOptions
  /** Top-level and rule-level context, already combined and trimmed. */
  readonly context?: string
}

/**
 * Top-level first, then rule-specific, separated by a blank line. Whitespace-only
 * context is absent rather than empty, so it never reaches a request.
 */
export function combineContext(top?: string, rule?: string): string | undefined {
  const parts = [top, rule]
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

function numeric(severity: Exclude<Severity, "off">): NumericSeverity {
  return severity === "error" ? 2 : 1
}

/**
 * Rules not mentioned in `rules` run at `meta.defaultSeverity`: listing a
 * plugin turns its rules on. The consumer is an agent that should get
 * findings with zero config. `"off"` is the only way to disable.
 */
export function resolveRules(config: ResolvedConfig, ruleFilter?: string): EnabledRule[] {
  const enabled: EnabledRule[] = []
  for (const plugin of config.plugins) {
    for (const rule of plugin.rules) {
      const ruleId = `${plugin.id}/${rule.name}`
      if (ruleFilter !== undefined && ruleFilter !== ruleId) continue

      const setting = config.rules[ruleId]
      let severity: Severity = rule.meta.defaultSeverity
      let options: RuleOptions = {}

      if (typeof setting === "string") {
        severity = setting
      } else if (Array.isArray(setting)) {
        severity = setting[0]
        options = setting[1] as RuleOptions
      }
      if (severity === "off") continue

      const context = combineContext(config.context, options.context)
      enabled.push({
        ruleId,
        rule,
        plugin: plugin as Plugin,
        severity: numeric(severity),
        options,
        ...(context === undefined ? {} : { context }),
      })
    }
  }
  return enabled
}

export function knownRuleIds(config: ResolvedConfig): string[] {
  return config.plugins.flatMap((p) => p.rules.map((r) => `${p.id}/${r.name}`))
}
