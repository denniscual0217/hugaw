export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js"
export { assertJson, stableStringify } from "./json.js"

export type {
  Answer,
  AnswerFor,
  Answers,
  ChoiceAnswer,
  ChoiceCriterion,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  Question,
  QuestionSet,
  ScoreAnswer,
  ScoreCriteria,
  ScoreQuestion,
} from "./questions.js"
export { choice, noul, score } from "./questions.js"

export type {
  AnyRule,
  AskInput,
  Candidate,
  CandidateSliceInput,
  DecideInput,
  Facts,
  Finding,
  LanguageAdapter,
  LanguageTypes,
  LoadInput,
  Location,
  NumericSeverity,
  Plugin,
  Program,
  Rule,
  RuleContext,
  RuleMeta,
  RuleOptions,
  Selection,
  Severity,
  SliceExtractor,
  SliceScope,
  Slices,
  UnitSliceInput,
  Verdict,
} from "./types.js"

export { defineAdapter, definePlugin, defineRule, isAdapter, isPlugin } from "./define.js"

export type { Judge, JudgeRequest, JudgeResponse, JudgeUsage } from "./judge.js"
export { JudgeError } from "./judge.js"

export type { Cache } from "./cache.js"
export { cacheKey, noopCache } from "./cache.js"

export type { EnabledRule, HugawConfig, ResolvedConfig } from "./config.js"
export {
  combineContext,
  configSchema,
  defineConfig,
  knownRuleIds,
  resolveConfig,
  resolveRules,
} from "./config.js"

export { applyMessageOptions, interpolate } from "./message.js"

export type {
  RequestCandidateRef,
  RequestRecord,
  RunError,
  RunReport,
  RunStats,
  SkipRecord,
  Truncation,
} from "./report.js"
export { emptyStats, truncateFindings } from "./report.js"

export type { RunInput } from "./runner.js"
export {
  DEFAULT_CONCURRENCY,
  NAMESPACE_SEPARATOR,
  CONTEXT_CITATION,
  CONTEXT_KEY,
  runLint,
} from "./runner.js"
