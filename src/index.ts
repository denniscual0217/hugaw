/**
 * hugaw — a context-aware linter.
 *
 * The public surface is deliberately core-only plus the TypeScript adapter:
 * React lives behind the "hugaw/react" entry point, because hugaw is not a
 * React linter.
 */

export * from "./core/index.js"

export { typescriptAdapter } from "./adapters/typescript/index.js"
export type { FunctionLike, TsAdapterOptions, TsTypes } from "./adapters/typescript/index.js"

export { dryRunJudge } from "./judge/dry-run.js"
export { withCache } from "./judge/cached.js"

export { toEslint } from "./format/to-eslint.js"
export { stylish } from "./format/stylish.js"
export { json as jsonFormatter } from "./format/json.js"
export { dryRun as dryRunFormatter } from "./format/dry-run.js"
export type { EslintMessage, EslintResult } from "./format/types.js"

export { computeExitCode } from "./cli/exit-code.js"
export { VERSION } from "./version.js"
