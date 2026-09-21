import pc from "picocolors"
import { ZodError } from "zod"
import type { Cache, Judge, LanguageAdapter, RunReport } from "../core/index.js"
import { configSchema, noopCache, runLint, truncateFindings } from "../core/index.js"
import { dryRun } from "../format/dry-run.js"
import { externalFormatter, FormatterNotInstalledError } from "../format/external.js"
import { json, jsonWithMetadata } from "../format/json.js"
import { stylish } from "../format/stylish.js"
import { toEslint } from "../format/to-eslint.js"
import type { Colors, EslintRulesMeta } from "../format/types.js"
import { usageClause, usageMetadata } from "../format/usage.js"
import { dryRunJudge } from "../judge/dry-run.js"
import { defaultAdapters } from "./defaults.js"
import { computeExitCode } from "./exit-code.js"
import { loadConfig } from "./load-config.js"

export interface CliFlags {
  readonly globs: readonly string[]
  readonly rule?: string | undefined
  readonly format: string
  readonly maxWarnings: number
  readonly maxFindings: number
  readonly dryRun: boolean
  readonly cache: boolean
  readonly config?: string | undefined
}

export interface Io {
  out(text: string): void
  err(text: string): void
  readonly cwd: string
  readonly isTty: boolean
  readonly env: Record<string, string | undefined>
}

export function defaultIo(): Io {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    cwd: process.cwd(),
    isTty: process.stdout.isTTY === true,
    env: process.env,
  }
}

export async function run(flags: CliFlags, io: Io = defaultIo()): Promise<number> {
  // picocolors' default export auto-enables on TERM/FORCE_COLOR heuristics;
  // the spec says no ANSI unless stdout is a TTY, so build our own instance.
  const colors = pc.createColors(io.isTty) as unknown as Colors

  let raw: Record<string, unknown>
  let configPath: string | null
  try {
    const loaded = await loadConfig(io.cwd, flags.config)
    raw = loaded.raw
    configPath = loaded.path
  } catch (error) {
    io.err(colors.red(`Failed to load config: ${message(error)}`))
    return 2
  }
  if (configPath === null && flags.config === undefined) {
    io.err(colors.dim("No hugaw.config.* found — using built-in defaults (typescript + react)."))
  }

  let config
  try {
    config = { ...configSchema.parse(raw), raw }
  } catch (error) {
    io.err(colors.red(`Invalid config${configPath === null ? "" : ` in ${configPath}`}:`))
    if (error instanceof ZodError) {
      for (const issue of error.issues) {
        io.err(colors.red(`  ${issue.path.join(".") || "<root>"}: ${issue.message}`))
      }
    } else {
      io.err(colors.red(`  ${message(error)}`))
    }
    return 2
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous adapters
  const adapters: readonly LanguageAdapter<any, any>[] = config.adapters ?? defaultAdapters

  let judge: Judge
  const cache: Cache = noopCache
  if (flags.dryRun) {
    judge = dryRunJudge
  } else {
    if ((io.env["TYPESAFE_API_KEY"] ?? "").trim() === "") {
      io.err(colors.red("TYPESAFE_API_KEY is not set (put it in .env or the environment)"))
      return 2
    }
    try {
      // Imported lazily so --dry-run never loads the SDK at all.
      const { TypeSafeJudge } = await import("../judge/typesafe.js")
      judge = new TypeSafeJudge({ model: config.model })
    } catch (error) {
      io.err(colors.red(`Failed to initialise the TypeSafe judge: ${message(error)}`))
      return 2
    }
  }

  let report: RunReport
  try {
    report = await runLint({
      config,
      adapters,
      judge,
      cache,
      cwd: io.cwd,
      files: flags.globs,
      ...(flags.rule === undefined ? {} : { ruleFilter: flags.rule }),
    })
  } catch (error) {
    io.err(colors.red(`Lint run failed: ${message(error)}`))
    return 2
  }

  const fatal = report.errors.filter((e) => e.fatal)
  if (fatal.length > 0) {
    for (const error of fatal) io.err(colors.red(error.message))
    return 2
  }
  for (const error of report.errors) {
    const where = error.filePath === undefined ? "" : ` (${error.filePath})`
    io.err(colors.yellow(`warning: ${error.ruleId ?? "hugaw"}${where}: ${error.message}`))
  }

  if (flags.dryRun) {
    io.out(dryRun(report, io.cwd))
    return report.errors.length > 0 ? 2 : 0
  }

  const { findings, truncation } = truncateFindings(report.findings, flags.maxFindings)
  const results = toEslint(findings)

  if (flags.format === "json" || flags.format === "json-with-metadata") {
    io.out(
      flags.format === "json"
        ? json(results)
        : jsonWithMetadata(results, {
            rulesMeta: rulesMetaOf(config.plugins),
            usage: usageMetadata(report.stats),
          }),
    )
    // stdout stays pure JSON for both, so `| jq` works either way; the human
    // stats line goes to stderr. The usage numbers are *in* the document for
    // json-with-metadata and nowhere for json, which is what keeps `json` an
    // unchanged LintResult[].
    const usage = usageClause(report.stats)
    io.err(
      `${report.stats.candidates} candidates, ${report.stats.skippedStatically} skipped statically, ` +
        `${report.stats.judged} judged${usage === null ? "" : ` · ${usage}`}`,
    )
    if (truncation.truncated) {
      io.err(
        `… showing ${truncation.shown} of ${truncation.total} findings. Re-run with --max-findings 0 for the rest.`,
      )
    }
  } else if (flags.format === "stylish") {
    io.out(
      stylish(results, {
        cwd: io.cwd,
        colors,
        stats: report.stats,
        truncation,
        incompleteErrors: report.errors.length,
      }),
    )
  } else {
    try {
      io.out(
        await externalFormatter(flags.format, results, {
          cwd: io.cwd,
          rulesMeta: rulesMetaOf(config.plugins),
        }),
      )
    } catch (error) {
      if (error instanceof FormatterNotInstalledError) {
        io.err(colors.red(error.message))
        return 2
      }
      io.err(colors.red(`Formatter "${flags.format}" failed: ${message(error)}`))
      return 2
    }
  }

  return computeExitCode(report, { maxWarnings: flags.maxWarnings })
}

function rulesMetaOf(
  plugins: readonly { id: string; rules: readonly { name: string; meta: { description: string; docsUrl?: string } }[] }[],
): EslintRulesMeta {
  const meta: EslintRulesMeta = {}
  for (const plugin of plugins) {
    for (const rule of plugin.rules) {
      meta[`${plugin.id}/${rule.name}`] = {
        type: "suggestion",
        docs: {
          description: rule.meta.description,
          ...(rule.meta.docsUrl === undefined ? {} : { url: rule.meta.docsUrl }),
        },
      }
    }
  }
  return meta
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
