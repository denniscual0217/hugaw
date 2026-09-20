import {
  APIError,
  APIConnectionError,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk"
import type { Fetch, Questions } from "@typesafe-ai/sdk"
import type { Answer, Judge, JudgeRequest, JudgeResponse, Question } from "../core/index.js"
import { JudgeError } from "../core/index.js"

export interface TypeSafeJudgeOptions {
  readonly model?: string
  readonly apiKey?: string
  readonly baseURL?: string
  readonly timeout?: number
  readonly maxRetries?: number
  /** Injectable transport — the unit tests assert the wire body through this. */
  readonly fetch?: Fetch
}

/**
 * The only file in the tree that imports `@typesafe-ai/sdk`.
 *
 * Core's question shapes are a structural subset of the SDK's, so questions
 * pass through unmapped; answers are validated against the question types on
 * the way back, because schema drift would otherwise surface as
 * `undefined > 0.4` quietly passing a threshold gate.
 */
export class TypeSafeJudge implements Judge {
  readonly #client: TypeSafeClient
  readonly #model: string | undefined

  constructor(options: TypeSafeJudgeOptions = {}) {
    try {
      this.#client = new TypeSafeClient({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.maxRetries === undefined ? {} : { retry: { maxRetries: options.maxRetries } }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    } catch (error) {
      if (error instanceof TypeSafeError) {
        throw new JudgeError(error.message, undefined, { cause: error })
      }
      throw error
    }
    this.#model = options.model
  }

  async judge(request: JudgeRequest): Promise<JudgeResponse | null> {
    const model = request.model || this.#model
    try {
      const result = await this.#client.systemOne({
        state: request.state,
        questions: request.questions as unknown as Questions,
        ...(model === undefined ? {} : { model }),
      })

      const answers: Record<string, Answer> = {}
      for (const [key, answer] of Object.entries(result.answers)) {
        const question: Question | undefined = request.questions[key]
        const typed = answer as Answer
        if (question && typed.type !== question.type) {
          throw new JudgeError(
            `Answer for "${key}" is a ${typed.type}, expected a ${question.type} — API schema drift`,
          )
        }
        answers[key] = typed
      }

      return {
        answers,
        model: result.model,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      }
    } catch (error) {
      throw toJudgeError(error)
    }
  }
}

function toJudgeError(error: unknown): JudgeError {
  if (error instanceof JudgeError) return error
  if (error instanceof APIError) {
    return new JudgeError(`${describeStatus(error.status)}: ${error.message}`, error.status, {
      cause: error,
    })
  }
  if (error instanceof APIConnectionError) {
    return new JudgeError(`could not reach the TypeSafe API: ${error.message}`, undefined, {
      cause: error,
    })
  }
  if (error instanceof TypeSafeError) {
    return new JudgeError(error.message, undefined, { cause: error })
  }
  return new JudgeError(error instanceof Error ? error.message : String(error), undefined, {
    cause: error,
  })
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "TYPESAFE_API_KEY was rejected (HTTP 401)"
    case 422:
      return "the request was rejected as invalid (HTTP 422)"
    case 429:
      return "rate limited (HTTP 429)"
    case 529:
      return "the API is overloaded (HTTP 529)"
    default:
      return `the API returned HTTP ${status}`
  }
}
