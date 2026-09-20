# THE PLAN

## 0. Research findings the implementer must not re-derive

### `@typesafe-ai/sdk` 0.6.0 (verified from source)

```ts
import { TypeSafeClient, score, noul, choice, APIError, RateLimitError, TypeSafeError } from "@typesafe-ai/sdk"

new TypeSafeClient(config?: {
  apiKey?: string            // falls back to process.env.TYPESAFE_API_KEY; throws TypeSafeError if neither
  baseURL?: string
  defaultModel?: string      // SDK default "jev-latest"
  timeout?: number           // default 10_000 ms
  retry?: Partial<RetryPolicy>   // maxRetries default 2; retries 408/429/5xx with backoff, honours Retry-After
  fetch?: (input: string, init?: RequestInit) => Promise<Response>   // <- injectable; use it for unit tests
  logLevel?: "debug"|"info"|"warn"|"error"|"off"
})

client.systemOne<const Q extends Questions>(
  request: { state: EntryType; questions: Q; model?: string },
  options?: { signal?; timeout?; retry?; headers? }
): APIPromise<SystemOneResult<Q>>   // awaitable

// EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null
score(instructions, criteria: readonly [EntryType, EntryType, ...EntryType[]])  // throws if not array
noul(instructions = null, criteria?: { true?: EntryType; false?: EntryType } | null)
choice(instructions, criteria: { [label: string]: Description })

// SystemOneResult<Q> = { model: string; answers: { [K in keyof Q]: ResultFor<Q[K]> }; usage: { input_tokens; output_tokens } }
// NoulResponse   = { type:"noul";   noul: number }        // NO confidence
// ScoreResponse  = { type:"score";  score: number; confidence: number; legend: {"0":..}; probabilities: {"0":n,...} }
// ChoiceResponse = { type:"choice"; choice: string; confidence: number; probabilities: Record<label, number> }
```
Wire: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body `{ state, model, questions }`; Score criteria 2–10 levels; Choice max 255; errors 401/422/429/529. Package is dual ESM/CJS, engines node >= 20.

### ESLint result schema (verified)
`LintResult`: `filePath` (absolute), `messages`, `suppressedMessages`, `errorCount`, `fatalErrorCount`, `warningCount`, `fixableErrorCount`, `fixableWarningCount`, `usedDeprecatedRules` (omit `source`/`output`/`stats`).
`LintMessage`: `ruleId: string|null`, `severity: 1|2`, `message`, `messageId?`, `line`, `column` (1-based), `endLine`, `endColumn`, `nodeType: string|null`. We emit no `fix`/`suggestions`. Third-party formatters are `(results, context) => string | Promise<string>` with `context = { cwd, rulesMeta, maxWarningsExceeded?, color? }`.

### ts-morph (verified against 26.x .d.ts; 28.0.0 same for these members)
`new Project({ tsConfigFilePath?, compilerOptions?, skipAddingFilesFromTsConfig, skipFileDependencyResolution, skipLoadingLibFiles })`, `project.addSourceFilesAtPaths(globs)`, `project.resolveSourceFileDependencies()`, `project.createSourceFile(path, text)`, `sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)`, `node.getSymbol()`, `symbol.getDeclarations()`, `symbol.getAliasedSymbol()`, `symbol.compilerSymbol`, `identifier.getDefinitionNodes()`, `node.findReferencesAsNodes()`, `Node.isImportSpecifier(n)` -> `n.getImportDeclaration().getModuleSpecifierValue()`, `node.getFirstAncestor(pred)`, `getFirstAncestorByKind`, `JsxOpeningElement/JsxSelfClosingElement.getTagNameNode()`, `.getAttributes()`, `JsxAttribute.getNameNode()`, `.getInitializer()` (-> `JsxExpression.getExpression()`), `sourceFile.getLineAndColumnAtPos(pos)` (1-based both), `node.getStart()`, `node.getEnd()`, `node.getKindName()`, `ts.JsxEmit / ScriptTarget / ModuleKind` re-exported from `ts-morph` as `ts`.

### Runtime
Node v22.22.0: `process.loadEnvFile(path)` exists (does not override already-set vars). TS 7.0.2 on npm is the native port — tsup's `dts` needs the 5.x compiler API, so pin `typescript ~5.9.3`.

---

## 1. File tree

```
hugaw/
├── package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  README.md  hugaw.config.ts
├── src/
│   ├── index.ts     public barrel: defineConfig/defineRule/definePlugin/defineAdapter, score/noul/choice, runLint, core types
│   ├── react.ts     `export { default } from "./plugins/react/index.js"` -> package export "hugaw/react"
│   ├── bin.ts       shebang, loads .env via process.loadEnvFile, calls cli/main
│   ├── core/        *** ZERO imports from ts-morph, react, @typesafe-ai/sdk, adapters/, plugins/, judge/, cli/ ***
│   │   ├── types.ts      LanguageTypes, LanguageAdapter, Program, Plugin, Rule, Candidate, Selection, SliceExtractor, Slices, Location, Finding, Verdict, Facts, RuleMeta, RuleContext, AskInput, DecideInput
│   │   ├── questions.ts  Question/Answer unions, QuestionSet, Answers<Q>, score()/noul()/choice() (core-owned, wire-identical)
│   │   ├── json.ts       JsonValue / JsonObject + assertJson()
│   │   ├── judge.ts      Judge interface, JudgeRequest, JudgeResponse, JudgeError
│   │   ├── cache.ts      Cache interface, noopCache, cacheKey(sha256)
│   │   ├── config.ts     zod schema, HugawConfig / ResolvedConfig, defineConfig, resolveRules()
│   │   ├── define.ts     defineRule / definePlugin / defineAdapter (validate rule.context subset of plugin.slices)
│   │   ├── message.ts    interpolate("{facts}"), applyMessageOptions(verdict, ruleOptions)
│   │   ├── report.ts     RunReport, RunStats, SkipRecord, RequestRecord, RunError, truncateFindings()
│   │   ├── runner.ts     runLint(): select->skip->group->slices->batch->judge->demux->decide
│   │   ├── index.ts      core barrel
│   │   ├── runner.test.ts        fake text-language adapter + two fake rules: namespacing/demux, unit-slice-once, dry-run short-circuit
│   │   └── architecture.test.ts  greps src/core/**/*.ts for forbidden imports — mechanical guard for the "not a React linter" rule
│   ├── adapters/typescript/
│   │   ├── index.ts      typescriptAdapter: LanguageAdapter<TsTypes, TsAdapterOptions>; TsProgram implements Program<TsTypes>
│   │   ├── types.ts      TsTypes = { file: SourceFile; node: Node; unit: FunctionLike }
│   │   ├── options.ts    zod schema { tsconfig?: string } -> parseOptions()
│   │   ├── project.ts    createProject({ cwd, tsconfig?, files })
│   │   ├── units.ts      unitOf(node), unitKey(unit), unitName(unit)
│   │   ├── imports.ts    importSourceOf(node) -> { module, importedName } | null; resolveDeclaration(node)
│   │   ├── references.ts referencesWithin(bindingNameNode, scope) -> Identifier[]
│   │   ├── locate.ts     locate(node) -> Location (1-based)
│   │   └── index.test.ts
│   ├── plugins/react/
│   │   ├── index.ts      definePlugin({ id:"react", language:"typescript", rules:[pointlessUseMemo], slices })
│   │   ├── analysis/react-imports.ts   isReactApi(node, "useMemo"|"memo"|...) — named, default (React.x), namespace imports
│   │   ├── analysis/memo-components.ts isMemoComponentTag(tagNameNode, program) — memo(...)/React.memo(...)/memo(forwardRef(...)), same-file or cross-file
│   │   ├── analysis/hooks.ts           isHookCall(call), isInsideDependencyArray(identifier)
│   │   ├── analysis/context.ts         isContextValueAttribute(jsxAttribute) — <X.Provider value> or <Ctx value> where Ctx <- createContext
│   │   ├── analysis/usages.ts          classifyUsage(identifier) -> Usage { line, kind, description, resolved }
│   │   ├── slices/component-source.ts  scope "unit"
│   │   ├── slices/memo-call.ts         scope "candidate"
│   │   ├── slices/value-usages.ts      scope "candidate"
│   │   ├── slices/callee-sources.ts    scope "candidate"
│   │   ├── rules/pointless-usememo.ts  select/skip/context/ask/decide + thresholds + message builder
│   │   ├── rules/pointless-usememo.test.ts  decide() table tests with hand-built answers
│   │   └── index.test.ts               fixture table tests via test/helpers
│   ├── judge/typesafe.ts   TypeSafeJudge: wraps TypeSafeClient.systemOne; maps errors -> JudgeError
│   ├── judge/dry-run.ts    dryRunJudge: `judge: async () => null`
│   ├── judge/cached.ts     withCache(judge, cache)
│   ├── judge/typesafe.test.ts  fake fetch injected into SDK; asserts wire body + answer passthrough
│   ├── format/types.ts     EslintResult / EslintMessage (verbatim schema)
│   ├── format/to-eslint.ts findings -> EslintResult[] (absolute paths, counts)
│   ├── format/stylish.ts   relative paths, injected picocolors instance, stats line, truncation notice
│   ├── format/json.ts      JSON.stringify(toEslint(...), null, 2)
│   ├── format/external.ts  dynamic `eslint-formatter-<name>`
│   ├── format/dry-run.ts   prints { requests, skipped, stats } JSON
│   ├── format/stylish.test.ts, format/to-eslint.test.ts
│   └── cli/
│       ├── main.ts         cac definition
│       ├── run.ts          load config -> pick judge -> runLint -> format -> exit code
│       ├── load-config.ts  find hugaw.config.{ts,mts,js,mjs} or --config; jiti import; zod validate
│       ├── defaults.ts     default adapters [typescriptAdapter] and plugins [react]
│       └── exit-code.ts    computeExitCode(report, { maxWarnings })
├── fixtures/               (excluded from tsconfig; parsed only by ts-morph)
└── test/
    ├── helpers/mock-judge.ts    createMockJudge(script) -> { judge, calls }
    ├── helpers/run-fixture.ts   runFixture(relPath, { judge, rule? }) -> RunReport
    ├── helpers/fake-language.ts text-line LanguageAdapter + plugin for core/runner.test.ts
    ├── setup.ts                 process.loadEnvFile(".env") if present
    ├── cli.test.ts              spawns `node dist/bin.js`; skipped if dist missing
    └── live.test.ts             HUGAW_LIVE=1 only
```

---

## 2. Core type signatures (the spine)

```ts
// src/core/json.ts
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// src/core/types.ts
export interface Location { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number }  // 1-based

/** Type-level bag an adapter fills in. Core never inspects these; it only threads them through. */
export interface LanguageTypes { readonly file: unknown; readonly node: unknown; readonly unit: unknown }

export interface Program<T extends LanguageTypes = LanguageTypes> {
  readonly files: readonly T["file"][]
  filePath(file: T["file"]): string                 // absolute
  fileOf(node: T["node"]): T["file"]
  unitOf(node: T["node"]): T["unit"] | null         // nearest enclosing function-like; null at module scope
  unitKey(unit: T["unit"]): string                  // `${absPath}#${startOffset}`
  unitName(unit: T["unit"]): string
  locate(node: T["node"]): Location
  nodeType(node: T["node"]): string                 // "CallExpression" -> ESLint nodeType
  textOf(node: T["node"]): string
  dispose(): void
}

export interface LanguageAdapter<T extends LanguageTypes = LanguageTypes, O = unknown> {
  readonly id: string                               // "typescript"
  readonly extensions: readonly string[]
  /** Pulls its own keys (e.g. `tsconfig`) out of the raw config. Core does not know the key names. */
  parseOptions(raw: Record<string, unknown>): O
  load(input: { readonly files: readonly string[]; readonly cwd: string; readonly options: O }): Promise<Program<T>>
}

export interface Selection<T extends LanguageTypes, D = unknown> {
  readonly node: T["node"]; readonly data: D; readonly unit?: T["unit"]
}
export interface Candidate<T extends LanguageTypes = LanguageTypes, D = unknown> {
  readonly id: string            // `${ruleId}@${filePath}:${line}:${column}`
  readonly ruleId: string; readonly filePath: string
  readonly node: T["node"]; readonly unit: T["unit"]; readonly unitKey: string
  readonly loc: Location; readonly nodeType: string; readonly data: D
}

export type SliceScope = "unit" | "candidate"
export interface UnitSliceInput<T extends LanguageTypes> { readonly unit: T["unit"]; readonly unitKey: string; readonly program: Program<T> }
export interface CandidateSliceInput<T extends LanguageTypes, D = unknown> extends UnitSliceInput<T> { readonly candidate: Candidate<T, D> }
export type SliceExtractor<T extends LanguageTypes = LanguageTypes> =
  | { readonly scope: "unit";      extract(input: UnitSliceInput<T>): JsonValue }
  | { readonly scope: "candidate"; extract(input: CandidateSliceInput<T, any>): JsonValue }
export type Slices<Names extends string = string> = Readonly<Record<Names, JsonValue>>
```
`scope` exists because `component_source` is shared by every candidate in a unit (built once, cached by `unitKey`) while `memo_call`/`value_usages`/`callee_sources` are per candidate.

```ts
// src/core/questions.ts
export interface ScoreQuestion<L extends readonly [string, string, ...string[]] = readonly [string, string, ...string[]]> { readonly type: "score"; readonly instructions: string; readonly criteria: L }
export interface NoulQuestion { readonly type: "noul"; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } }
export interface ChoiceQuestion<C extends Record<string, string | null> = Record<string, string | null>> { readonly type: "choice"; readonly instructions: string; readonly criteria: C }
export type Question = ScoreQuestion | NoulQuestion | ChoiceQuestion
export type QuestionSet = Readonly<Record<string, Question>>

export interface ScoreAnswer { readonly type: "score"; readonly score: number; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>>; readonly legend: Readonly<Record<string, string>> }
export interface NoulAnswer { readonly type: "noul"; readonly noul: number }      // no confidence — by design
export interface ChoiceAnswer<K extends string = string> { readonly type: "choice"; readonly choice: K; readonly confidence: number; readonly probabilities: Readonly<Record<K, number>> }
export type Answer = ScoreAnswer | NoulAnswer | ChoiceAnswer

export type AnswerFor<Q extends Question> =
  Q extends ScoreQuestion ? ScoreAnswer : Q extends NoulQuestion ? NoulAnswer :
  Q extends ChoiceQuestion<infer C> ? ChoiceAnswer<keyof C & string> : never
export type Answers<Q extends QuestionSet> = { readonly [K in keyof Q]: AnswerFor<Q[K]> }

export function score<const L extends readonly [string, string, ...string[]]>(instructions: string, criteria: L): ScoreQuestion<L>  // throws if length > 10 or < 2
export function noul(instructions: string, criteria?: { true: string; false: string }): NoulQuestion
export function choice<const C extends Record<string, string | null>>(instructions: string, criteria: C): ChoiceQuestion<C>
```
Rules import `score`/`noul` from core, never from the SDK, so the SDK is confined to `src/judge/typesafe.ts`. The shapes are a structural subset of the SDK's `Question`, so the judge passes them through without mapping.

```ts
export type Facts = Readonly<Record<string, JsonValue>>
export type Severity = "off" | "warn" | "error"
export interface RuleOptions<F extends Facts = Facts> { readonly message?: string | ((facts: F) => string); readonly messageSuffix?: string }
export interface RuleMeta { readonly description: string; readonly defaultSeverity: Exclude<Severity, "off">; readonly docsUrl?: string }
export interface RuleContext<T extends LanguageTypes> { readonly ruleId: string; readonly program: Program<T> }
export interface AskInput<T extends LanguageTypes, D> { readonly candidate: Candidate<T, D>; readonly slices: Slices }
export interface DecideInput<T extends LanguageTypes, D> extends AskInput<T, D> {}
export interface Verdict<F extends Facts = Facts> { readonly messageId: string; readonly message: string; readonly facts: F }

export interface Rule<T extends LanguageTypes = LanguageTypes, D = unknown, Q extends QuestionSet = QuestionSet, F extends Facts = Facts> {
  readonly name: string            // ruleId = `${plugin.id}/${name}`
  readonly meta: RuleMeta
  readonly context: readonly string[]
  select(file: T["file"], ctx: RuleContext<T>): Iterable<Selection<T, D>>
  skip(candidate: Candidate<T, D>, ctx: RuleContext<T>): string | null     // reason string => dropped, never judged
  ask(input: AskInput<T, D>): Q
  decide(answers: Answers<Q>, input: DecideInput<T, D>): Verdict<F> | null
}
export type AnyRule<T extends LanguageTypes> = Rule<T, any, any, any>

export interface Plugin<T extends LanguageTypes = LanguageTypes> {
  readonly id: string; readonly language: string
  readonly rules: readonly AnyRule<T>[]
  readonly slices: Readonly<Record<string, SliceExtractor<T>>>
}

export function defineRule<T extends LanguageTypes, D, Q extends QuestionSet, F extends Facts>(rule: Rule<T, D, Q, F>): Rule<T, D, Q, F>
export function definePlugin<T extends LanguageTypes>(plugin: Plugin<T>): Plugin<T>   // throws if any rule.context name not in plugin.slices
export function defineAdapter<T extends LanguageTypes, O>(adapter: LanguageAdapter<T, O>): LanguageAdapter<T, O>
```
**Inference note**: declare the question object as a module const (`const questions = { cost: score(...), identity_matters: noul(...) }`), `type Q = typeof questions`, and call `defineRule<TsTypes, MemoData, Q, MemoFacts>({...})` with explicit generics. Do not rely on TS inferring `Q` from `ask`'s return type through a context-sensitive `decide` — it is fragile.

```ts
export interface Finding {
  readonly ruleId: string; readonly severity: 1 | 2
  readonly messageId: string; readonly message: string
  readonly filePath: string; readonly loc: Location; readonly nodeType: string; readonly facts: Facts
}
// src/core/judge.ts
export interface JudgeRequest { readonly id: string; readonly model: string; readonly state: JsonObject; readonly questions: Readonly<Record<string, Question>> }  // keys already namespaced `${ruleId}::${qid}`
export interface JudgeResponse { readonly answers: Readonly<Record<string, Answer>>; readonly model?: string; readonly usage?: { readonly input_tokens: number; readonly output_tokens: number } }
export interface Judge { /** Returns null to decline (dry-run). Runner records the request and skips decide(). */ judge(request: JudgeRequest): Promise<JudgeResponse | null> }
export class JudgeError extends Error { constructor(message: string, readonly status?: number, readonly cause?: unknown) }
// src/core/cache.ts
export interface Cache { get(key: string): Promise<JudgeResponse | undefined>; set(key: string, value: JudgeResponse): Promise<void> }
export const noopCache: Cache
export function cacheKey(req: JudgeRequest): string    // sha256 of stableStringify({model,state,questions})
```

```ts
// src/core/config.ts (zod 4)
const severity = z.enum(["off", "warn", "error"])
const ruleOptions = z.object({ message: z.union([z.string(), z.custom<(f: any) => string>(v => typeof v === "function")]).optional(), messageSuffix: z.string().optional() })
const ruleSetting = z.union([severity, z.tuple([severity, ruleOptions])])
export const configSchema = z.looseObject({       // loose: adapter keys (tsconfig) pass through untouched
  files: z.array(z.string()).default(["**/*.{ts,tsx}"]),
  ignores: z.array(z.string()).default(["**/node_modules/**", "**/dist/**"]),
  model: z.string().default("jev-1.13.0"),
  plugins: z.array(z.custom<Plugin>(isPlugin)).default([]),
  adapters: z.array(z.custom<LanguageAdapter>(isAdapter)).optional(),
  rules: z.record(z.string(), ruleSetting).default({}),
  cache: z.object({ enabled: z.boolean().default(true), dir: z.string().default(".hugaw-cache") }).optional(),   // placeholder
  limits: z.object({ maxRequests: z.number().int().positive().optional() }).optional(),                          // placeholder
  resolve: z.object({ digestDepth: z.number().int().optional(), knownHooks: z.array(z.string()).optional() }).optional(),  // placeholder
})
export type HugawConfig = z.input<typeof configSchema>
export type ResolvedConfig = z.output<typeof configSchema> & { readonly raw: Record<string, unknown> }
export function defineConfig(c: HugawConfig): HugawConfig
export interface EnabledRule<T> { ruleId: string; rule: AnyRule<T>; plugin: Plugin<T>; severity: 1 | 2; options: RuleOptions }
export function resolveRules(config: ResolvedConfig, ruleFilter?: string): EnabledRule<any>[]
```
Decision: rules not mentioned in `rules` run at `meta.defaultSeverity` (plugins listed => rules on); `"off"` disables. Reason: the consumer is an agent that should get findings with zero config.

---

## 3. Runner algorithm (`src/core/runner.ts`)

```ts
export interface RunInput {
  readonly config: ResolvedConfig
  readonly adapters: readonly LanguageAdapter<any, any>[]
  readonly judge: Judge
  readonly cache?: Cache                 // default noopCache
  readonly cwd: string
  readonly files?: readonly string[]     // CLI positional globs; overrides config.files (ignores still apply)
  readonly ruleFilter?: string
  readonly concurrency?: number          // default 8
}
export function runLint(input: RunInput): Promise<RunReport>
```

1. **Resolve rules.** Error if a plugin's `language` matches no adapter id; error if `--rule` matches nothing.
2. **Glob.** `tinyglobby.glob(files ?? config.files, { cwd, ignore: config.ignores, absolute: true })`. Partition by adapter `extensions`. Files matching no adapter are dropped silently.
3. **Load programs.** Per adapter with >=1 file: `options = adapter.parseOptions(config.raw)`; `program = await adapter.load({...})`. Load errors fatal (`RunError{fatal:true}`, exit 2).
4. **Select + skip (free).** Per file, per enabled rule of that language: `for (const sel of rule.select(file, ctx))` -> build `Candidate` (`unit = sel.unit ?? program.unitOf(node)`; null -> `SkipRecord{reason:"outside any function"}`); `stats.candidates++`; `reason = rule.skip(candidate, ctx)`; if string -> `SkipRecord`, `stats.skippedStatically++`, continue; else `survivors`. Exceptions caught per file/candidate into `report.errors` (non-fatal).
5. **Group by unit -> slots.** `Map<unitKey, Map<ruleId, Candidate[]>>`, sorted by `loc`. `slotCount = max(candidates.length per rule)`. Slot *i* holds the *i*-th candidate of each rule that has one. **One `JudgeRequest` per (unit, slot).** Rationale: a request must carry exactly one `memo_call` or the question is ambiguous. In practice a component has <=1 useMemo so slots = 1.
6. **Build state once.** Per (unit, slot): `needed = union of rule.context`. Unit-scoped slices computed at most once per `unitKey` (memo `Map<unitKey, Map<sliceName, JsonValue>>`); candidate-scoped once per candidate. `state = { ...unitSlices, ...candidateSlices }`. Guard: if two rules in a slot request the same candidate-scoped slice, split them into separate slots (document in code; unreachable for MVP).
7. **Merge questions.** Per rule: `qs = rule.ask({candidate, slices})`; `request.questions[`${ruleId}::${qid}`] = q`. Validate `qid` contains no `::`. `request = { id: `${unitKey}#${slot}`, model: config.model, state, questions }`. Push `RequestRecord{unitKey, unitName, filePath, candidates:[{ruleId, loc}], request}` **always**, so `--dry-run` and tests can see it.
8. **Judge, bounded.** `pLimit(concurrency)`; `cached = await cache.get(cacheKey(req))`; `response = cached ?? await judge.judge(req)`; if `null` -> mark `judged:false`, continue (dry-run; `decide` never runs). Else `cache.set`, `stats.judged += candidates in slot`, `stats.requests++`, accumulate usage. `JudgeError` -> `report.errors` (non-fatal per request, but exit 2 at the end because results are incomplete).
9. **Demultiplex.** Per rule: strip prefix `${ruleId}::` from answer keys. Assert every asked `qid` has an answer (else `RunError`). `verdict = rule.decide(own, {candidate, slices})`.
10. **Findings.** `message = applyMessageOptions(verdict, enabledRule.options)` (template/fn override, then `messageSuffix` appended with a space); push `Finding`.
11. **Finish.** Sort by `(filePath, line, column)`; `program.dispose()`; return `RunReport { findings, skipped, requests, stats: { files, candidates, skippedStatically, judged, requests, inputTokens, outputTokens }, errors }`.

`--max-findings` truncation is NOT the runner's job; `truncateFindings(report, n)` in `report.ts` returns `{ shown, total }` and the formatter prints the notice.

### `--dry-run` threading
- `cli/run.ts`: `const judge = flags.dryRun ? dryRunJudge : withCache(new TypeSafeJudge({ model }), cache)`. The API-key check happens only inside `TypeSafeJudge`'s constructor, so `--dry-run` works with no key.
- `src/judge/dry-run.ts`: `export const dryRunJudge: Judge = { judge: async () => null }`. That is the entire short-circuit; nothing in core knows about the flag.
- `format/dry-run.ts` prints `{ "requests": [{ unit, file, candidates, request: { model, state, questions } }], "skipped": [...], "stats": {...} }` to stdout, exit 0. Cache is bypassed in dry-run (CLI passes `noopCache`) so printed payloads are always what would be sent.

---

## 4. package.json / tsconfig / tsup / vitest

```jsonc
{
  "name": "hugaw", "version": "0.1.0", "type": "module", "license": "MIT",
  "description": "Context-aware linter: resolved code slices judged by TypeSafe Jev, ESLint-compatible output.",
  "engines": { "node": ">=22" }, "packageManager": "pnpm@9.9.0",
  "bin": { "hugaw": "./dist/bin.js" },
  "files": ["dist"],
  "exports": {
    ".":       { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./react": { "types": "./dist/react.d.ts", "import": "./dist/react.js" },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsup", "dev": "tsup --watch", "typecheck": "tsc --noEmit",
    "test": "vitest run", "test:watch": "vitest",
    "test:live": "HUGAW_LIVE=1 vitest run test/live.test.ts",
    "hugaw": "node dist/bin.js"
  },
  "dependencies": {
    "@typesafe-ai/sdk": "^0.6.0", "ts-morph": "^28.0.0", "cac": "^6.7.14",
    "picocolors": "^1.1.1", "p-limit": "^7.3.3", "zod": "^4.6.5",
    "jiti": "^2.7.0", "tinyglobby": "^0.2.17"
  },
  "devDependencies": { "typescript": "~5.9.3", "tsup": "^8.5.1", "vitest": "^4.1.11", "@types/node": "^22.20.4" }
}
```
Calls made: `cac` stays on 6.x (7.0.0 is ESM-only with an unverified API). `jiti` for config loading. `tinyglobby` is already a transitive dep of ts-morph. No `tsx`.

`tsconfig.json`:
```jsonc
{ "compilerOptions": {
    "target": "ES2022", "lib": ["ES2023"], "module": "ESNext", "moduleResolution": "Bundler",
    "types": ["node"], "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true, "noUnusedLocals": true, "noUnusedParameters": true,
    "verbatimModuleSyntax": true, "isolatedModules": true, "skipLibCheck": true, "noEmit": true,
    "resolveJsonModule": true, "esModuleInterop": true,
    "paths": { "hugaw": ["./src/index.ts"], "hugaw/react": ["./src/react.ts"] } },
  "include": ["src", "test", "tsup.config.ts", "vitest.config.ts", "hugaw.config.ts"],
  "exclude": ["fixtures", "dist", "node_modules"] }
```
`fixtures/` excluded on purpose: they `import from "react"` with no `@types/react`; ts-morph parses them fine without types.

`tsup.config.ts`: `{ entry: { index: "src/index.ts", react: "src/react.ts", bin: "src/bin.ts" }, format: ["esm"], target: "node22", platform: "node", dts: true, splitting: true, sourcemap: true, clean: true, treeshake: true }`. Do NOT set `banner` — the shebang lives in `src/bin.ts`.

`vitest.config.ts`: `{ test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], environment: "node", testTimeout: 30_000, setupFiles: ["test/setup.ts"] }, resolve: { alias: { "hugaw/react": "/src/react.ts", hugaw: "/src/index.ts" } } }`.

### Mock judge injection
No globals, no `vi.mock`. The runner receives `judge` by parameter.
```ts
export type MockScript = (req: JudgeRequest) => Record<string, number | Partial<Answer>>  // keyed by bare qid
export function createMockJudge(script?: MockScript): { judge: Judge; calls: JudgeRequest[] }
```
For each namespaced key it strips `…::`, looks up the script value, and synthesises a full answer from the question type: number for score -> `{type:"score", score, confidence: 0.9 default, probabilities mass on floor/ceil, legend from criteria}`; number for noul -> `{type:"noul", noul}`. `run-fixture.ts` wires `typescriptAdapter` + `react` + mock judge into `runLint`. `should-skip` tests assert `calls.length === 0`, `stats.judged === 0`, and the exact `skipped[i].reason`. `core/runner.test.ts` uses `fake-language.ts` so core is proven to work with no ts-morph at all.

---

## 5. TypeScript adapter
- `project.ts`: with `options.tsconfig` -> `new Project({ tsConfigFilePath: resolve(cwd, tsconfig), skipAddingFilesFromTsConfig: true })`; else `new Project({ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, allowJs: true, strict: false, skipLibCheck: true, noEmit: true } })`. Then `addSourceFilesAtPaths(files)`; `resolveSourceFileDependencies()`.
- `units.ts`: `unitOf = node.getFirstAncestor(n => Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isMethodDeclaration(n))`; `unitName`: FunctionDeclaration name, or enclosing VariableDeclaration name for arrows, else `<anonymous>`; `unitKey = `${filePath}#${unit.getStart()}``.
- `imports.ts`: `importSourceOf(expr)`: Identifier -> `getSymbol()?.getDeclarations()[0]`; `ImportSpecifier` -> `{ module: decl.getImportDeclaration().getModuleSpecifierValue(), name: (decl.getPropertyNameNode() ?? decl.getNameNode()).getText() }`; PropertyAccess `React.useMemo` -> left identifier's decl is `ImportClause` (default) or `NamespaceImport` -> `getFirstAncestorByKind(SyntaxKind.ImportDeclaration)`, name = property name. Works **without @types/react** because the local alias symbol and its declaration exist syntactically. `resolveDeclaration(identifier)`: `getDefinitionNodes()[0]`, fallback `getSymbol()?.getAliasedSymbol()?.getDeclarations()[0]`.
- `references.ts`: `sym = nameNode.getSymbol()`; scan `scope.getDescendantsOfKind(SyntaxKind.Identifier)` where text matches and `id.getSymbol()?.compilerSymbol === sym.compilerSymbol`, excluding the declaration name. Symbol equality handles shadowing.
- `locate.ts`: `sf.getLineAndColumnAtPos(node.getStart())` / `getEnd()` -> 1-based `Location`.

---

## 6. React plugin

`analysis/react-imports.ts`: `isReactApi(callee, name)` true when `importSourceOf(callee)` is `{ module: "react", name }` (also `React.name` via default/namespace import).

`rules/pointless-usememo.ts`:
- `name: "pointless-usememo"`, `meta.defaultSeverity: "warn"`, `context: ["component_source", "memo_call", "value_usages", "callee_sources"]`.
- **select**: every `CallExpression` whose callee `isReactApi(_, "useMemo")`. `data: MemoData = { binding: Identifier | null }` — the `VariableDeclaration` name when parent is `const x = useMemo(...)`, null if destructured/inline/returned.
- **skip** (return these exact strings; tests assert them):
  1. `"result is not bound to a simple identifier"` — destructured / inline / returned directly.
  2. `"memoized value escapes the component (returned or assigned outward)"` — any reference is a ReturnStatement expression or an assignment to an outer binding. Covers custom hooks.
  3. `"passed as prop to React.memo component <X>"` — reference is a JsxExpression initializer of a JsxAttribute whose element's tag `isMemoComponentTag` (memo(...)/React.memo(...)/memo(forwardRef(...)), same-file or cross-file incl. `export default memo(Comp)`).
  4. `"listed in dependency array of <hook>"` — reference's parent is an ArrayLiteralExpression argument of a call whose callee text matches `/^(React\.)?use[A-Z]/`.
  5. `"used as context value on <Tag>"` — reference is the initializer of a JsxAttribute named `value` on `<X.Provider>` or on `<Ctx>` whose declaration initializer is `createContext(...)`.
- **ask**: the two questions verbatim from SPEC.md §3.
- **decide**: constants `IDENTITY_MATTERS_MAX = 0.4`, `COST_MAX = 1.2`, `MIN_CONFIDENCE = 0.6`; order exactly as spec; facts `MemoFacts = { binding, costScore, costLevel, costConfidence, identityMatters, usageLines, usageCount, unresolvedUsages, unresolvedCallees }`; `messageId: "pointlessUseMemo"`.
- **message**: `useMemo has no effect — ${costPhrase}, and \`${binding}\` is only read at line${s} ${lines}; inline the expression and remove the dep array` where costPhrase = `"constant work"` (level 0) / `"a single pass over a small collection"` (level 1), level = `Math.round(costScore)`; zero usages -> `` `x` is never read ``. Caveat appended after `; ` ONLY if: `unresolvedCallees.length > 0` -> `${n} callee(s) (${names}) unresolved across files — verify before removing`; `unresolvedUsages > 0` -> `${k} of ${n} usages unresolved behind a spread — verify before removing`; `0.2 < identityMatters <= 0.4` -> `weak identity signal (${pct}%) — verify no consumer compares references`. Never otherwise.

`slices/`: `component_source` (unit scope; text of enclosing VariableStatement if the unit is an arrow, else the declaration; cap 12000 chars with `/* …truncated… */`); `memo_call` `{ line, source, binding, deps: string[] }`; `value_usages` `Usage[]` where `Usage = { line, kind, description, resolved }`, `kind in jsx-child | jsx-prop | member-access | call-argument | hook-argument | spread | returned | assigned | other` (`spread`/`other` are `resolved:false`); `callee_sources` `{ resolved: { [name]: source }, unresolved: string[] }` for bare-identifier callees inside the factory — same-file declaration text (cap 2000 chars) or the name under `unresolved`.

---

## 7. Fixtures (each is a row in `src/plugins/react/index.test.ts`)

`fixtures/should-warn/` — mock answers default `cost 0.1, identity 0.05` unless noted; assert exactly one finding, line/column, message substring.
1. `constant-object.tsx` — the Price example: object literal memo, read once in JSX; same-file `format()` inlined into `callee_sources.resolved`. No caveat.
2. `string-format.tsx` — template-string memo read at two lines; message says `lines 4, 9`.
3. `arithmetic.tsx` — `a * b` consumed as JSX text; proves `jsx-child`.
4. `plain-child-prop.tsx` — prop to a *non*-memo component; proves memo-detection doesn't over-skip.
5. `cross-file-callee.tsx` + `_helpers.ts` — imported helper; `callee_sources.unresolved = ["slugify"]`; caveat "unresolved across files".
6. `spread-usage.tsx` — `<div {...style}>`; caveat "unresolved behind a spread".
7. `react-namespace.tsx` — `import * as React` + `React.useMemo`.
8. `weak-identity-caveat.tsx` — mock `identity 0.3`; reported with "weak identity signal" caveat.

`fixtures/should-skip/` — assert `calls.length === 0` and the reason string.
9. `memo-child-prop.tsx` — `const Child = React.memo(...)` same file.
10. `memo-child-cross-file.tsx` + `_MemoChild.tsx` — `export default memo(Child)`; cross-file.
11. `dep-array.tsx` — value in `useEffect(..., [value])`.
12. `custom-hook-dep-array.tsx` — value in `useDebounced(fn, [value])`.
13. `context-provider-value.tsx` — `<Ctx.Provider value={value}>`.
14. `context-react19-value.tsx` — `<Ctx value={value}>` with `Ctx = createContext(...)`.
15. `returned-from-hook.tsx` — custom hook `return useMemo(...)`.
16. `not-react-usememo.tsx` — `useMemo` from `./my-memo`; asserts `stats.candidates === 0`.

`fixtures/should-stay-silent/` — assert `calls.length === 1` and zero findings.
17. `sort-and-group.tsx` — mock `cost 2.4`.
18. `low-confidence.tsx` — mock `cost 0.5, confidence 0.3`.
19. `identity-ambiguous.tsx` — `trackIdentity(value)`; mock `identity 0.7`.

Plus `test/live.test.ts` (`describe.skipIf(!process.env.HUGAW_LIVE)`) running fixture 1 through the real `TypeSafeJudge`, asserting one finding with `cost.score < 1.2`.

---

## 8. CLI

`cac`: `cli.command("[...globs]").option("--rule <id>").option("--format <name>", { default: "stylish" }).option("--max-warnings <n>", { default: -1 }).option("--max-findings <n>", { default: 0 }).option("--dry-run").option("--no-cache").option("--config <path>")`. `--config` is an addition (needed for the dogfood config and tests). `cli.help(); cli.version(VERSION); cli.parse()`.

`run.ts` order: load config (jiti `createJiti(import.meta.url).import(path, { default: true })`, search `hugaw.config.{ts,mts,js,mjs}` upward from cwd; none -> `defaults.ts` + stderr note) -> `configSchema.parse` (zod error -> pretty message, exit 2) -> adapters = `config.adapters ?? [typescriptAdapter]` -> judge selection -> `runLint` -> format -> exit code.

Formatting: `stylish` -> `format/stylish.ts(results, { cwd, colors, stats, truncation })`; `json` -> stdout, stats line to **stderr** (keeps stdout pure JSON); anything else -> `format/external.ts` (`import(\`eslint-formatter-${name}\`)`, `mod.default ?? mod`, awaited; missing -> `Formatter "x" not installed: pnpm add -D eslint-formatter-x`, exit 2). Dry run -> `format/dry-run.ts` regardless of `--format`, exit 0.

Stylish exactness: file path line; `  ${line}:${col}  ${sev}  ${message}  ${ruleId}` column-aligned per file; blank line; `✖ N problem(s) (E errors, W warnings)`; stats line `N candidates, N skipped statically, N judged`; if truncated `… showing N of M findings. Re-run with --max-findings 0 for the rest.`; if no findings the single green line `✓ no findings · N candidates, N skipped statically, N judged`. Colors: `pc.createColors(process.stdout.isTTY === true)` created once in `cli/run.ts` and passed down; JSON and dry-run never colored; tests use `createColors(false)`.

Exit codes: 2 if `report.errors` non-empty; 1 if any severity-2 finding or `maxWarnings >= 0 && warningCount > maxWarnings`; else 0.

`src/bin.ts` first line is literally `#!/usr/bin/env node`, then: if `existsSync(join(process.cwd(), ".env"))` -> `process.loadEnvFile(path)` in try/catch; then `import("./cli/main.js").then(m => m.main())`.

---

## 9. Build order — `--dry-run` end to end before any network code
1. package.json, tsconfig, tsup.config, vitest.config, `pnpm install`; `src/bin.ts` printing version. Gate: `pnpm typecheck && pnpm build && node dist/bin.js --version`.
2. All of `src/core/*` + `architecture.test.ts` (forbidden-import grep).
3. `src/core/runner.ts` + `src/judge/dry-run.ts` + `test/helpers/{fake-language,mock-judge}.ts` + `core/runner.test.ts`.
4. `src/adapters/typescript/*` + its test on a fixture without tsconfig.
5. React `analysis/*`, `slices/*`, rule `select`/`skip`/`context` (leave `decide` returning null). `run-fixture.ts`; all `should-skip` fixtures green with `calls.length === 0`.
6. `src/cli/*`, `src/format/{dry-run,stylish,json,to-eslint}.ts`, `src/react.ts`, `src/index.ts`. Gate: `node dist/bin.js fixtures/should-warn/constant-object.tsx --dry-run` prints the payload with all four slices; `--format json` prints `[]` plus stats on stderr. **No SDK import exists in the tree at this point.**
7. Rule `ask` + `decide` + message builder; `should-warn` and `should-stay-silent` tables; `pointless-usememo.test.ts` threshold table.
8. `src/judge/typesafe.ts` + `cached.ts` + `typesafe.test.ts` (inject fake `fetch`, assert wire body and passthrough); `test/live.test.ts`.
9. `format/external.ts`, `--max-findings`/`--max-warnings`, exit codes, `test/cli.test.ts`, `hugaw.config.ts` dogfood, README.

---

## 10. Gotchas (decisions already made)
- **ts-morph without tsconfig**: explicit `compilerOptions` with `jsx: ts.JsxEmit.Preserve`, `allowJs: true`; `resolveSourceFileDependencies()` after adding files. `react` is unresolvable (no @types/react) — all "imported from react" checks must be **syntactic** via ImportSpecifier/ImportClause/NamespaceImport, never the type checker. Never call `getType()` in skip logic. Keep `fixtures/` out of `tsconfig.include`.
- **ESM + tsup + bin shebang**: `#!/usr/bin/env node` as the literal first line of `src/bin.ts`; esbuild preserves hashbangs and tsup chmods 755. Do NOT also use tsup `banner`. `splitting: true` means `bin.js` imports shared chunks — fine. Verify `./dist/bin.js --help`.
- **Node ESM**: all relative imports inside `src/` use `.js` extensions; `verbatimModuleSyntax` forces `import type` for type-only imports (needed so core never pulls a runtime dep by accident).
- **picocolors TTY**: the default export auto-enables on FORCE_COLOR/TERM heuristics, violating "no ANSI unless isTTY". Use `pc.createColors(process.stdout.isTTY === true)` once and pass it down.
- **.env without a dep**: `process.loadEnvFile(join(cwd, ".env"))` guarded by `existsSync` + try/catch. Does not overwrite existing env vars, so CI-provided keys win. Missing key -> `TYPESAFE_API_KEY is not set (put it in .env or the environment)`, exit 2 — but only when not `--dry-run`.
- **Zod 4**: `.passthrough()` deprecated -> `z.looseObject`; `z.function()` is no longer a schema -> `z.custom` for the message function. Keep `config.raw` so adapters can `parseOptions(raw)`.
- **Question key hygiene**: `qid` must not contain `::`; `definePlugin` rejects slice names that aren't valid identifiers (they appear verbatim in question text).
- **Score criteria limit**: core `score()` throws if `criteria.length > 10 || < 2`, mirroring the API 422 locally.
- **Answer sanity**: `TypeSafeJudge` validates each answer's `type` matches the question's `type` before returning — otherwise schema drift surfaces as `undefined > 0.4` silently passing the identity gate.
- **Column semantics**: `getLineAndColumnAtPos` is 1-based, matching ESLint; do not add 1.
- **Cache key determinism**: `stableStringify` with sorted keys.
- **Dogfooding**: `hugaw.config.ts` imports from `"hugaw"`; `load-config.ts` sets jiti `alias: { hugaw: resolve("src/index.ts"), "hugaw/react": resolve("src/react.ts") }` when `process.env.HUGAW_DEV=1`. Tests never go through the config file — they construct `ResolvedConfig` directly.
