import type { JsonValue } from "./json.js"
import type { Answers, Question, QuestionSet } from "./questions.js"

/** 1-based, matching ESLint. */
export interface Location {
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * Type-level bag a language adapter fills in. Core never inspects these; it
 * only threads them through, which is why core contains no ts-morph types.
 */
export interface LanguageTypes {
  readonly file: unknown
  readonly node: unknown
  readonly unit: unknown
}

/** The adapter's runtime facade over a parsed program. */
export interface Program<T extends LanguageTypes = LanguageTypes> {
  readonly files: readonly T["file"][]
  /** Absolute path. */
  filePath(file: T["file"]): string
  fileOf(node: T["node"]): T["file"]
  /** Nearest enclosing function-like; null at module scope. */
  unitOf(node: T["node"]): T["unit"] | null
  /** Stable identity, e.g. `${absPath}#${startOffset}`. */
  unitKey(unit: T["unit"]): string
  unitName(unit: T["unit"]): string
  locate(node: T["node"]): Location
  /** ESLint-style node type, e.g. "CallExpression". */
  nodeType(node: T["node"]): string
  textOf(node: T["node"]): string
  dispose(): void
}

export interface LoadInput<O> {
  readonly files: readonly string[]
  readonly cwd: string
  readonly options: O
}

export interface LanguageAdapter<T extends LanguageTypes = LanguageTypes, O = unknown> {
  readonly id: string
  readonly extensions: readonly string[]
  /** Pulls its own keys (e.g. `tsconfig`) out of the raw config. Core does not know the key names. */
  parseOptions(raw: Record<string, unknown>): O
  load(input: LoadInput<O>): Promise<Program<T>>
}

export interface Selection<T extends LanguageTypes, D = unknown> {
  readonly node: T["node"]
  readonly data: D
  readonly unit?: T["unit"]
}

export interface Candidate<T extends LanguageTypes = LanguageTypes, D = unknown> {
  /** `${ruleId}@${filePath}:${line}:${column}` */
  readonly id: string
  readonly ruleId: string
  readonly filePath: string
  readonly node: T["node"]
  readonly unit: T["unit"]
  readonly unitKey: string
  readonly loc: Location
  readonly nodeType: string
  readonly data: D
}

export type SliceScope = "unit" | "candidate"

export interface UnitSliceInput<T extends LanguageTypes> {
  readonly unit: T["unit"]
  readonly unitKey: string
  readonly program: Program<T>
}

export interface CandidateSliceInput<T extends LanguageTypes, D = unknown> extends UnitSliceInput<T> {
  readonly candidate: Candidate<T, D>
}

/**
 * `scope` exists because a slice like `component_source` is shared by every
 * candidate in a unit (built once, cached by unitKey) while `memo_call` is
 * necessarily per candidate.
 */
export type SliceExtractor<T extends LanguageTypes = LanguageTypes> =
  | { readonly scope: "unit"; extract(input: UnitSliceInput<T>): JsonValue }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rule data is rule-private
  | { readonly scope: "candidate"; extract(input: CandidateSliceInput<T, any>): JsonValue }

export type Slices<Names extends string = string> = Readonly<Record<Names, JsonValue>>

export type Facts = Readonly<Record<string, JsonValue>>
export type Severity = "off" | "warn" | "error"
export type NumericSeverity = 1 | 2

export interface RuleOptions<F extends Facts = Facts> {
  readonly message?: string | ((facts: F) => string)
  readonly messageSuffix?: string
  /**
   * Free-text project context the model should weigh — a fact about this
   * codebase that no AST extractor could supply. Reaches the request state as
   * `context`; costs tokens on every request for the rule.
   *
   * Not to be confused with `Rule.context`, which is a rule author's list of
   * slice names. This one is a config author's prose; they never meet.
   */
  readonly context?: string
}

export interface RuleMeta {
  readonly description: string
  readonly defaultSeverity: Exclude<Severity, "off">
  readonly docsUrl?: string
}

export interface RuleContext<T extends LanguageTypes> {
  readonly ruleId: string
  readonly program: Program<T>
}

export interface AskInput<T extends LanguageTypes, D> {
  readonly candidate: Candidate<T, D>
  readonly slices: Slices
}

export type DecideInput<T extends LanguageTypes, D> = AskInput<T, D>

export interface Verdict<F extends Facts = Facts> {
  readonly messageId: string
  readonly message: string
  readonly facts: F
}

/** The five functions. Only `ask` costs money. */
export interface Rule<
  T extends LanguageTypes = LanguageTypes,
  D = unknown,
  Q extends QuestionSet = QuestionSet,
  F extends Facts = Facts,
> {
  /** ruleId is `${plugin.id}/${name}`. */
  readonly name: string
  readonly meta: RuleMeta
  /** Slice names this rule needs in the request state. */
  readonly context: readonly string[]
  select(file: T["file"], ctx: RuleContext<T>): Iterable<Selection<T, D>>
  /**
   * Optional static escape hatch: a reason string drops the candidate, which
   * is then never judged and never reported.
   *
   * Omit it unless a candidate can be ruled out on syntax *alone*. A rule that
   * encodes "this one is definitely fine" recreates the static-analysis
   * failure hugaw exists to avoid — if the answer needs judgement, let the
   * model judge it and put the reasoning in a slice instead.
   */
  skip?(candidate: Candidate<T, D>, ctx: RuleContext<T>): string | null
  ask(input: AskInput<T, D>): Q
  decide(answers: Answers<Q>, input: DecideInput<T, D>): Verdict<F> | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous rule list
export type AnyRule<T extends LanguageTypes = LanguageTypes> = Rule<T, any, any, any>

export interface Plugin<T extends LanguageTypes = LanguageTypes> {
  readonly id: string
  /** Must match a `LanguageAdapter.id`. */
  readonly language: string
  readonly rules: readonly AnyRule<T>[]
  readonly slices: Readonly<Record<string, SliceExtractor<T>>>
}

export interface Finding {
  readonly ruleId: string
  readonly severity: NumericSeverity
  readonly messageId: string
  readonly message: string
  readonly filePath: string
  readonly loc: Location
  readonly nodeType: string
  readonly facts: Facts
}

export type { Question, QuestionSet, Answers }
