import type { EslintResult } from "./types.js"

export interface FormatterContext {
  cwd: string
  rulesMeta: Record<string, { type?: string; docs?: { description?: string; url?: string } }>
  maxWarningsExceeded?: { maxWarnings: number; foundWarnings: number }
}

export class FormatterNotInstalledError extends Error {
  constructor(readonly formatterName: string) {
    super(
      `Formatter "${formatterName}" not installed: pnpm add -D eslint-formatter-${formatterName}`,
    )
    this.name = "FormatterNotInstalledError"
  }
}

/** Any other `--format <name>` resolves `eslint-formatter-<name>` (SPEC §4). */
export async function externalFormatter(
  name: string,
  results: readonly EslintResult[],
  context: FormatterContext,
): Promise<string> {
  const specifier = `eslint-formatter-${name}`
  let module: unknown
  try {
    module = await import(/* @vite-ignore */ specifier)
  } catch {
    throw new FormatterNotInstalledError(name)
  }
  const candidate = (module as { default?: unknown }).default ?? module
  if (typeof candidate !== "function") {
    throw new TypeError(`"${specifier}" does not export a formatter function`)
  }
  const format = candidate as (
    results: readonly EslintResult[],
    context: FormatterContext,
  ) => string | Promise<string>
  return await format(results, context)
}
