import { NAMESPACE_SEPARATOR } from "../../src/core/runner.js"
import type { Judge, JudgeRequest, JudgeResponse } from "../../src/core/judge.js"
import type { Answer, Question } from "../../src/core/questions.js"

/** A number is the headline value (score / noul probability); an object overrides fields. */
export type MockAnswerSpec = number | string | Record<string, unknown>
export type MockScript = (request: JudgeRequest) => Record<string, MockAnswerSpec>

const DEFAULT_CONFIDENCE = 0.9

function scoreProbabilities(score: number, levels: number): Record<string, number> {
  const probabilities: Record<string, number> = {}
  for (let i = 0; i < levels; i++) probabilities[String(i)] = 0
  const clamped = Math.min(Math.max(score, 0), levels - 1)
  const lo = Math.floor(clamped)
  const hi = Math.min(Math.ceil(clamped), levels - 1)
  if (lo === hi) {
    probabilities[String(lo)] = 1
  } else {
    const frac = clamped - lo
    probabilities[String(lo)] = 1 - frac
    probabilities[String(hi)] = frac
  }
  return probabilities
}

function synthesise(question: Question, spec: MockAnswerSpec | undefined): Answer {
  const override = typeof spec === "object" && spec !== null ? spec : {}

  if (question.type === "score") {
    const levels = question.criteria.length
    const raw = typeof spec === "number" ? spec : (override["score"] as number | undefined)
    const value = raw ?? 0
    const legend: Record<string, string> = {}
    question.criteria.forEach((text, i) => {
      legend[String(i)] = text
    })
    return {
      type: "score",
      score: value,
      confidence: (override["confidence"] as number | undefined) ?? DEFAULT_CONFIDENCE,
      probabilities:
        (override["probabilities"] as Record<string, number> | undefined) ??
        scoreProbabilities(value, levels),
      legend,
    }
  }

  if (question.type === "noul") {
    const raw = typeof spec === "number" ? spec : (override["noul"] as number | undefined)
    return { type: "noul", noul: raw ?? 0 }
  }

  const labels = Object.keys(question.criteria)
  const picked = typeof spec === "string" ? spec : ((override["choice"] as string | undefined) ?? labels[0] ?? "")
  const probabilities: Record<string, number> = {}
  for (const label of labels) probabilities[label] = label === picked ? 1 : 0
  return {
    type: "choice",
    choice: picked,
    confidence: (override["confidence"] as number | undefined) ?? DEFAULT_CONFIDENCE,
    probabilities,
  }
}

/**
 * No globals and no `vi.mock`: the runner takes its judge by parameter, so the
 * test just hands it a different one. `calls` is the cost model assertion —
 * `should-skip` fixtures require it to stay empty.
 */
export function createMockJudge(script?: MockScript): { judge: Judge; calls: JudgeRequest[] } {
  const calls: JudgeRequest[] = []
  const judge: Judge = {
    async judge(request) {
      calls.push(request)
      const answers: Record<string, Answer> = {}
      const specs = script ? script(request) : {}
      for (const [namespaced, question] of Object.entries(request.questions)) {
        const separator = namespaced.indexOf(NAMESPACE_SEPARATOR)
        const bare =
          separator === -1 ? namespaced : namespaced.slice(separator + NAMESPACE_SEPARATOR.length)
        answers[namespaced] = synthesise(question, specs[bare])
      }
      const response: JudgeResponse = {
        answers,
        model: request.model,
        usage: { input_tokens: 100, output_tokens: 0 },
      }
      return response
    },
  }
  return { judge, calls }
}
