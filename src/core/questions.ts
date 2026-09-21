/**
 * Core-owned question and answer shapes. They are a structural subset of the
 * TypeSafe SDK's wire types, so `src/judge/typesafe.ts` passes them straight
 * through. Rules import `score`/`noul`/`choice` from here and never from the
 * SDK, which is what keeps the SDK out of `src/core` and out of plugins.
 */

import type { JsonObject } from "./json.js"

export type ScoreCriteria = readonly [string, string, ...string[]]

export interface ScoreQuestion<L extends ScoreCriteria = ScoreCriteria> {
  readonly type: "score"
  readonly instructions: string
  readonly criteria: L
}

export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: { readonly true: string; readonly false: string }
}

/**
 * What one choice label's criterion may be.
 *
 * A plain string is the common case and stays the default reading. An object
 * is for a criterion with internal structure: a rule distinguishing a dozen
 * near-neighbour outcomes needs to say, per label, what it means, what
 * evidence in the state supports it, and which neighbour it is *not* — three
 * fields the model can weigh separately rather than one paragraph it must
 * parse. Widened here rather than per rule because `choice()` is the only way
 * a rule builds one, and a factory narrower than the type it returns would
 * force every such rule to cast around it.
 */
export type ChoiceCriterion = string | JsonObject | null

export interface ChoiceQuestion<
  C extends Record<string, ChoiceCriterion> = Record<string, ChoiceCriterion>,
> {
  readonly type: "choice"
  readonly instructions: string
  readonly criteria: C
}

export type Question = ScoreQuestion | NoulQuestion | ChoiceQuestion
export type QuestionSet = Readonly<Record<string, Question>>

export interface ScoreAnswer {
  readonly type: "score"
  readonly score: number
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly legend: Readonly<Record<string, string>>
}

/** Noul deliberately carries no confidence — the API does not return one. */
export interface NoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

export interface ChoiceAnswer<K extends string = string> {
  readonly type: "choice"
  readonly choice: K
  readonly confidence: number
  readonly probabilities: Readonly<Record<K, number>>
}

export type Answer = ScoreAnswer | NoulAnswer | ChoiceAnswer

export type AnswerFor<Q extends Question> = Q extends ScoreQuestion
  ? ScoreAnswer
  : Q extends NoulQuestion
    ? NoulAnswer
    : Q extends ChoiceQuestion<infer C>
      ? ChoiceAnswer<keyof C & string>
      : never

export type Answers<Q extends QuestionSet> = { readonly [K in keyof Q]: AnswerFor<Q[K]> }

export const MIN_SCORE_LEVELS = 2
export const MAX_SCORE_LEVELS = 10

/** Ordered rubric, levels 0..n-1. Mirrors the API's 422 locally. */
export function score<const L extends ScoreCriteria>(instructions: string, criteria: L): ScoreQuestion<L> {
  if (!Array.isArray(criteria)) {
    throw new TypeError("score() criteria must be an array of level descriptions")
  }
  if (criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) {
    throw new RangeError(
      `score() criteria must have between ${MIN_SCORE_LEVELS} and ${MAX_SCORE_LEVELS} levels, got ${criteria.length}`,
    )
  }
  return { type: "score", instructions, criteria }
}

/** Yes/no probability. Returns no confidence by design. */
export function noul(instructions: string, criteria?: { true: string; false: string }): NoulQuestion {
  return criteria === undefined
    ? { type: "noul", instructions }
    : { type: "noul", instructions, criteria }
}

export const MAX_CHOICE_LABELS = 255

export function choice<const C extends Record<string, ChoiceCriterion>>(
  instructions: string,
  criteria: C,
): ChoiceQuestion<C> {
  const labels = Object.keys(criteria)
  if (labels.length < 2) throw new RangeError("choice() needs at least two labels")
  if (labels.length > MAX_CHOICE_LABELS) {
    throw new RangeError(`choice() accepts at most ${MAX_CHOICE_LABELS} labels, got ${labels.length}`)
  }
  return { type: "choice", instructions, criteria }
}

export function isAnswerOfType(answer: Answer, type: Question["type"]): boolean {
  return answer.type === type
}
