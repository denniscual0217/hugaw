/** ESLint's LintMessage, verbatim minus the fields we never produce. */
export interface EslintMessage {
  ruleId: string | null
  severity: 1 | 2
  message: string
  messageId?: string
  line: number
  column: number
  endLine: number
  endColumn: number
  nodeType: string | null
}

/** ESLint's LintResult, verbatim minus `source`/`output`/`stats`. */
export interface EslintResult {
  filePath: string
  messages: EslintMessage[]
  suppressedMessages: EslintMessage[]
  errorCount: number
  fatalErrorCount: number
  warningCount: number
  fixableErrorCount: number
  fixableWarningCount: number
  usedDeprecatedRules: { ruleId: string; replacedBy: string[] }[]
}

/** The subset of a picocolors instance the formatters use. */
export interface Colors {
  bold: (s: string) => string
  dim: (s: string) => string
  red: (s: string) => string
  yellow: (s: string) => string
  green: (s: string) => string
  cyan: (s: string) => string
  underline: (s: string) => string
}
