import { cac } from "cac"
import { VERSION } from "../version.js"
import type { CliFlags } from "./run.js"
import { run } from "./run.js"

interface RawOptions {
  rule?: string
  format?: string
  maxWarnings?: string | number
  maxFindings?: string | number
  dryRun?: boolean
  cache?: boolean
  config?: string
}

function toNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function parseFlags(globs: string[], options: RawOptions): CliFlags {
  return {
    globs,
    rule: options.rule,
    format: options.format ?? "stylish",
    maxWarnings: toNumber(options.maxWarnings, -1),
    maxFindings: toNumber(options.maxFindings, 0),
    dryRun: options.dryRun === true,
    cache: options.cache !== false,
    config: options.config,
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cli = cac("hugaw")

  cli
    .command("[...globs]", "Lint files with context-aware rules")
    .option("--rule <id>", "Run only this rule")
    .option("--format <name>", "stylish (default) | json | eslint-formatter-*", { default: "stylish" })
    .option("--max-warnings <n>", "Exit 1 when warnings exceed this count (-1 disables)", { default: -1 })
    .option("--max-findings <n>", "Truncate output, announcing the truncation (0 disables)", { default: 0 })
    .option("--dry-run", "Print the exact request payloads and call nothing")
    .option("--no-cache", "Bypass the judgment cache")
    .option("--config <path>", "Path to a hugaw config file")
    .action(async (globs: string[], options: RawOptions) => {
      process.exitCode = await run(parseFlags(globs, options))
    })

  cli.help()
  cli.version(VERSION)

  const parsed = cli.parse(argv, { run: false })
  if (parsed.options["help"] === true || parsed.options["version"] === true) return
  await cli.runMatchedCommand()
}
