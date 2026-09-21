import pLimit from "p-limit"
import { glob } from "tinyglobby"
import type { Cache } from "./cache.js"
import { cacheKey, noopCache } from "./cache.js"
import type { EnabledRule, ResolvedConfig } from "./config.js"
import { knownRuleIds, resolveRules } from "./config.js"
import type { Judge, JudgeRequest, JudgeResponse } from "./judge.js"
import { JudgeError } from "./judge.js"
import type { JsonObject, JsonValue } from "./json.js"
import { applyMessageOptions } from "./message.js"
import type { Answer, Question } from "./questions.js"
import type { RequestRecord, RunError, RunReport, SkipRecord } from "./report.js"
import { emptyStats } from "./report.js"
import type {
  Candidate,
  Finding,
  LanguageAdapter,
  Location,
  Plugin,
  Program,
  SliceExtractor,
  Slices,
} from "./types.js"

/* eslint-disable @typescript-eslint/no-explicit-any -- the runner is the one place
   that is deliberately language-agnostic: adapter type bags are opaque here. */
type AnyProgram = Program<any>
type AnyCandidate = Candidate<any, any>

export const NAMESPACE_SEPARATOR = "::"
export const DEFAULT_CONCURRENCY = 8

/**
 * Where config-supplied project context lands in the request state.
 *
 * Not a slice: no plugin declares it and no rule requests it. It is core
 * behaviour so that any future plugin gets it for free, and the name is
 * reserved in `definePlugin` so a slice can never collide with it.
 */
export const CONTEXT_KEY = "context"

/** A state field the question never names tends to be ignored. */
export const CONTEXT_CITATION = "Take `context` into account."

function withContextCitation(question: Question): Question {
  // Rules typically return a module-level question object, so this must copy
  // rather than mutate — and must not append twice if a rule cites it itself.
  if (question.instructions.includes(CONTEXT_CITATION)) return question
  const instructions = `${question.instructions} ${CONTEXT_CITATION}`
  switch (question.type) {
    case "score":
      return { ...question, instructions }
    case "noul":
      return { ...question, instructions }
    case "choice":
      return { ...question, instructions }
  }
}

export interface RunInput {
  readonly config: ResolvedConfig
  readonly adapters: readonly LanguageAdapter<any, any>[]
  readonly judge: Judge
  readonly cache?: Cache
  readonly cwd: string
  /** CLI positional globs; overrides `config.files`. `ignores` still apply. */
  readonly files?: readonly string[]
  readonly ruleFilter?: string
  readonly concurrency?: number
}

interface Participant {
  readonly enabled: EnabledRule
  readonly candidate: AnyCandidate
  readonly slices: Slices
}

interface Job {
  readonly record: RequestRecord
  readonly participants: readonly Participant[]
}

interface UnitGroup {
  readonly unit: unknown
  readonly unitKey: string
  readonly unitName: string
  readonly filePath: string
  readonly program: AnyProgram
  readonly byRule: Map<string, AnyCandidate[]>
}

function compareLoc(a: Location, b: Location): number {
  return a.line - b.line || a.column - b.column
}

function extensionOf(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  const dot = file.lastIndexOf(".")
  return dot > slash ? file.slice(dot) : ""
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runLint(input: RunInput): Promise<RunReport> {
  const {
    config,
    adapters,
    judge,
    cache = noopCache,
    cwd,
    files: fileGlobs,
    ruleFilter,
    concurrency = DEFAULT_CONCURRENCY,
  } = input

  const findings: Finding[] = []
  const skipped: SkipRecord[] = []
  const requests: RequestRecord[] = []
  const errors: RunError[] = []
  const stats = emptyStats()

  const fail = (message: string): RunReport => {
    errors.push({ message, fatal: true })
    return { findings, skipped, requests, stats, errors }
  }

  // ── 1. Resolve rules ────────────────────────────────────────────────────
  if (ruleFilter !== undefined) {
    const known = knownRuleIds(config)
    if (!known.includes(ruleFilter)) {
      return fail(
        `Unknown rule "${ruleFilter}". Available: ${known.join(", ") || "none (no plugins configured)"}`,
      )
    }
  }
  const enabledRules = resolveRules(config, ruleFilter)
  const adapterById = new Map(adapters.map((a) => [a.id, a]))
  for (const { plugin } of enabledRules) {
    if (!adapterById.has(plugin.language)) {
      return fail(
        `Plugin "${plugin.id}" targets language "${plugin.language}" but no adapter provides it ` +
          `(loaded adapters: ${[...adapterById.keys()].join(", ") || "none"})`,
      )
    }
  }
  if (enabledRules.length === 0) {
    return { findings, skipped, requests, stats, errors }
  }

  // ── 2. Glob and partition by adapter ────────────────────────────────────
  const patterns = fileGlobs !== undefined && fileGlobs.length > 0 ? [...fileGlobs] : config.files
  let matched: string[]
  try {
    matched = await glob(patterns, {
      cwd,
      ignore: config.ignores,
      absolute: true,
      dot: false,
      onlyFiles: true,
    })
  } catch (error) {
    return fail(`Failed to expand file patterns: ${errorMessage(error)}`)
  }
  matched.sort()

  const byAdapter = new Map<string, string[]>()
  for (const file of matched) {
    const ext = extensionOf(file)
    for (const adapter of adapters) {
      if (adapter.extensions.includes(ext)) {
        const bucket = byAdapter.get(adapter.id)
        if (bucket) bucket.push(file)
        else byAdapter.set(adapter.id, [file])
        break
      }
    }
    // Files matching no adapter are dropped silently.
  }

  // ── 3. Load programs ────────────────────────────────────────────────────
  const programs = new Map<string, AnyProgram>()
  for (const [adapterId, adapterFiles] of byAdapter) {
    const adapter = adapterById.get(adapterId)
    if (!adapter) continue
    try {
      const options = adapter.parseOptions(config.raw)
      const program = await adapter.load({ files: adapterFiles, cwd, options })
      programs.set(adapterId, program)
      stats.files += program.files.length
    } catch (error) {
      for (const p of programs.values()) p.dispose()
      return fail(`Adapter "${adapterId}" failed to load: ${errorMessage(error)}`)
    }
  }

  try {
    // ── 4. Select + skip (free) ───────────────────────────────────────────
    const groups = new Map<string, UnitGroup>()

    for (const [adapterId, program] of programs) {
      const rulesHere = enabledRules.filter((r) => r.plugin.language === adapterId)
      for (const file of program.files) {
        const filePath = program.filePath(file)
        for (const enabled of rulesHere) {
          const ctx = { ruleId: enabled.ruleId, program }
          let selections: Iterable<{ node: unknown; data: unknown; unit?: unknown }>
          try {
            selections = enabled.rule.select(file, ctx)
          } catch (error) {
            errors.push({
              message: `select() threw: ${errorMessage(error)}`,
              fatal: false,
              filePath,
              ruleId: enabled.ruleId,
              cause: error,
            })
            continue
          }

          for (const selection of selections) {
            stats.candidates++
            let candidate: AnyCandidate
            try {
              const loc = program.locate(selection.node)
              const unit = selection.unit ?? program.unitOf(selection.node)
              if (unit === null || unit === undefined) {
                stats.skippedStatically++
                skipped.push({
                  ruleId: enabled.ruleId,
                  filePath,
                  loc,
                  reason: "outside any function",
                })
                continue
              }
              candidate = {
                id: `${enabled.ruleId}@${filePath}:${loc.line}:${loc.column}`,
                ruleId: enabled.ruleId,
                filePath,
                node: selection.node,
                unit,
                unitKey: program.unitKey(unit),
                loc,
                nodeType: program.nodeType(selection.node),
                data: selection.data,
              }
            } catch (error) {
              errors.push({
                message: `building candidate failed: ${errorMessage(error)}`,
                fatal: false,
                filePath,
                ruleId: enabled.ruleId,
                cause: error,
              })
              continue
            }

            let reason: string | null
            try {
              reason = enabled.rule.skip(candidate, ctx)
            } catch (error) {
              errors.push({
                message: `skip() threw: ${errorMessage(error)}`,
                fatal: false,
                filePath,
                ruleId: enabled.ruleId,
                cause: error,
              })
              continue
            }
            if (typeof reason === "string") {
              stats.skippedStatically++
              skipped.push({
                ruleId: enabled.ruleId,
                filePath,
                loc: candidate.loc,
                reason,
              })
              continue
            }

            // ── 5. Group by unit ────────────────────────────────────────
            let group = groups.get(candidate.unitKey)
            if (!group) {
              group = {
                unit: candidate.unit,
                unitKey: candidate.unitKey,
                unitName: program.unitName(candidate.unit),
                filePath,
                program,
                byRule: new Map(),
              }
              groups.set(candidate.unitKey, group)
            }
            const list = group.byRule.get(enabled.ruleId)
            if (list) list.push(candidate)
            else group.byRule.set(enabled.ruleId, [candidate])
          }
        }
      }
    }

    // ── 6/7. Slices + merged questions, one request per (unit, slot, bucket)
    const unitSliceCache = new Map<string, JsonValue>()
    const candidateSliceCache = new Map<string, JsonValue>()
    const enabledById = new Map(enabledRules.map((r) => [r.ruleId, r]))
    const jobs: Job[] = []

    const sliceFor = (plugin: Plugin, name: string): SliceExtractor | undefined =>
      (plugin.slices as Record<string, SliceExtractor | undefined>)[name]

    for (const group of groups.values()) {
      for (const list of group.byRule.values()) list.sort((a, b) => compareLoc(a.loc, b.loc))
      const slotCount = Math.max(...[...group.byRule.values()].map((l) => l.length))

      for (let slot = 0; slot < slotCount; slot++) {
        const slotRules: { enabled: EnabledRule; candidate: AnyCandidate }[] = []
        for (const [ruleId, list] of group.byRule) {
          const candidate = list[slot]
          const enabled = enabledById.get(ruleId)
          if (candidate && enabled) slotRules.push({ enabled, candidate })
        }
        if (slotRules.length === 0) continue

        // A candidate-scoped slice is ambiguous if two rules in one request
        // need it for *different* candidates, so those rules get their own
        // request. Unreachable with a single MVP rule; kept as a guard.
        const buckets: { enabled: EnabledRule; candidate: AnyCandidate }[][] = []
        const bucketCandidateSlices: Set<string>[] = []
        for (const entry of slotRules) {
          const own = new Set(
            entry.enabled.rule.context.filter(
              (name) => sliceFor(entry.enabled.plugin, name)?.scope === "candidate",
            ),
          )
          let placed = false
          for (let b = 0; b < buckets.length; b++) {
            const taken = bucketCandidateSlices[b]
            if (!taken) continue
            let overlaps = false
            for (const name of own) {
              if (taken.has(name)) {
                overlaps = true
                break
              }
            }
            if (!overlaps) {
              buckets[b]?.push(entry)
              for (const name of own) taken.add(name)
              placed = true
              break
            }
          }
          if (!placed) {
            buckets.push([entry])
            bucketCandidateSlices.push(new Set(own))
          }
        }

        for (const [bucketIndex, bucket] of buckets.entries()) {
          const state: JsonObject = {}
          const perRuleSlices = new Map<string, Record<string, JsonValue>>()
          let sliceFailed = false

          for (const { enabled, candidate } of bucket) {
            const own: Record<string, JsonValue> = {}
            for (const name of enabled.rule.context) {
              const extractor = sliceFor(enabled.plugin, name)
              if (!extractor) {
                errors.push({
                  message: `rule "${enabled.ruleId}" needs slice "${name}" which plugin "${enabled.plugin.id}" does not provide`,
                  fatal: false,
                  filePath: group.filePath,
                  ruleId: enabled.ruleId,
                })
                sliceFailed = true
                break
              }
              const key =
                extractor.scope === "unit"
                  ? `${group.unitKey}::${name}`
                  : `${candidate.id}::${name}`
              const cacheStore = extractor.scope === "unit" ? unitSliceCache : candidateSliceCache
              let value = cacheStore.get(key)
              if (value === undefined) {
                try {
                  value =
                    extractor.scope === "unit"
                      ? extractor.extract({
                          unit: group.unit,
                          unitKey: group.unitKey,
                          program: group.program,
                        })
                      : extractor.extract({
                          unit: group.unit,
                          unitKey: group.unitKey,
                          program: group.program,
                          candidate,
                        })
                } catch (error) {
                  errors.push({
                    message: `slice "${name}" threw: ${errorMessage(error)}`,
                    fatal: false,
                    filePath: group.filePath,
                    ruleId: enabled.ruleId,
                    cause: error,
                  })
                  sliceFailed = true
                  break
                }
                cacheStore.set(key, value)
              }
              state[name] = value
              own[name] = value
            }
            if (sliceFailed) break
            perRuleSlices.set(enabled.ruleId, own)
          }
          if (sliceFailed) continue

          const questions: Record<string, Question> = {}
          const participants: Participant[] = []
          let askFailed = false

          for (const { enabled, candidate } of bucket) {
            const slices = perRuleSlices.get(enabled.ruleId) ?? {}
            let asked: Record<string, Question>
            try {
              asked = enabled.rule.ask({ candidate, slices }) as Record<string, Question>
            } catch (error) {
              errors.push({
                message: `ask() threw: ${errorMessage(error)}`,
                fatal: false,
                filePath: candidate.filePath,
                ruleId: enabled.ruleId,
                cause: error,
              })
              askFailed = true
              break
            }
            for (const [qid, question] of Object.entries(asked)) {
              if (qid.includes(NAMESPACE_SEPARATOR)) {
                errors.push({
                  message: `question id "${qid}" must not contain "${NAMESPACE_SEPARATOR}"`,
                  fatal: false,
                  filePath: candidate.filePath,
                  ruleId: enabled.ruleId,
                })
                askFailed = true
                break
              }
              questions[`${enabled.ruleId}${NAMESPACE_SEPARATOR}${qid}`] =
                enabled.context === undefined ? question : withContextCitation(question)
            }
            if (askFailed) break
            participants.push({ enabled, candidate, slices })
          }
          if (askFailed || participants.length === 0) continue
          if (Object.keys(questions).length === 0) continue

          // One request batches several rules over one unit, so two rules with
          // *different* context would collide on a bare key. Namespace by rule
          // id exactly as the questions are — but only when the text actually
          // differs: a top-level entry shared by every rule is unambiguous as a
          // plain string, and repeating it per rule would multiply its token
          // cost for nothing.
          const contributors = participants.filter((p) => p.enabled.context !== undefined)
          const distinct = new Set(contributors.map((p) => p.enabled.context as string))
          if (distinct.size === 1) {
            state[CONTEXT_KEY] = [...distinct][0] as string
          } else if (distinct.size > 1) {
            const byRule: JsonObject = {}
            for (const { enabled } of contributors) byRule[enabled.ruleId] = enabled.context as string
            state[CONTEXT_KEY] = byRule
          }

          const suffix = bucketIndex === 0 ? "" : `.${bucketIndex}`
          const request: JudgeRequest = {
            id: `${group.unitKey}#${slot}${suffix}`,
            model: config.model,
            state,
            questions,
          }
          const record: RequestRecord = {
            unitKey: group.unitKey,
            unitName: group.unitName,
            filePath: group.filePath,
            candidates: participants.map((p) => ({ ruleId: p.enabled.ruleId, loc: p.candidate.loc })),
            request,
            judged: false,
          }
          requests.push(record)
          jobs.push({ record, participants })
        }
      }
    }

    // ── 8/9/10. Judge, demultiplex, decide ────────────────────────────────
    const limit = pLimit(Math.max(1, concurrency))
    await Promise.all(
      jobs.map((job) =>
        limit(async () => {
          const { record, participants } = job
          const key = cacheKey(record.request)
          let response: JudgeResponse | null
          try {
            const cached = await cache.get(key)
            if (cached !== undefined) {
              response = cached
            } else {
              response = await judge.judge(record.request)
              if (response !== null) await cache.set(key, response)
            }
          } catch (error) {
            errors.push({
              message:
                error instanceof JudgeError
                  ? `judge failed${error.status === undefined ? "" : ` (HTTP ${error.status})`}: ${error.message}`
                  : `judge failed: ${errorMessage(error)}`,
              fatal: false,
              filePath: record.filePath,
              cause: error,
            })
            return
          }

          if (response === null) {
            record.judged = false
            return
          }
          record.judged = true
          stats.requests++
          stats.judged += participants.length
          if (response.usage) {
            stats.inputTokens += response.usage.input_tokens
            stats.outputTokens += response.usage.output_tokens
          }

          for (const { enabled, candidate, slices } of participants) {
            const prefix = `${enabled.ruleId}${NAMESPACE_SEPARATOR}`
            const own: Record<string, Answer> = {}
            for (const [key2, answer] of Object.entries(response.answers)) {
              if (key2.startsWith(prefix)) own[key2.slice(prefix.length)] = answer
            }
            const asked = Object.keys(record.request.questions)
              .filter((k) => k.startsWith(prefix))
              .map((k) => k.slice(prefix.length))
            const missing = asked.filter((q) => own[q] === undefined)
            if (missing.length > 0) {
              errors.push({
                message: `judge returned no answer for ${missing.map((m) => `"${m}"`).join(", ")}`,
                fatal: false,
                filePath: candidate.filePath,
                ruleId: enabled.ruleId,
              })
              continue
            }

            let verdict: { messageId: string; message: string; facts: Record<string, JsonValue> } | null
            try {
              verdict = enabled.rule.decide(own as any, { candidate, slices })
            } catch (error) {
              errors.push({
                message: `decide() threw: ${errorMessage(error)}`,
                fatal: false,
                filePath: candidate.filePath,
                ruleId: enabled.ruleId,
                cause: error,
              })
              continue
            }
            if (verdict === null) continue

            findings.push({
              ruleId: enabled.ruleId,
              severity: enabled.severity,
              messageId: verdict.messageId,
              message: applyMessageOptions(verdict, enabled.options),
              filePath: candidate.filePath,
              loc: candidate.loc,
              nodeType: candidate.nodeType,
              facts: verdict.facts,
            })
          }
        }),
      ),
    )
  } finally {
    for (const program of programs.values()) {
      try {
        program.dispose()
      } catch {
        /* disposal is best-effort */
      }
    }
  }

  // ── 11. Finish ──────────────────────────────────────────────────────────
  findings.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || compareLoc(a.loc, b.loc) || a.ruleId.localeCompare(b.ruleId),
  )
  skipped.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || compareLoc(a.loc, b.loc) || a.ruleId.localeCompare(b.ruleId),
  )

  return { findings, skipped, requests, stats, errors }
}
