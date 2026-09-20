import type { JsonObject } from "./json.js"
import type { Answer, Question } from "./questions.js"

export interface JudgeRequest {
  /** `${unitKey}#${slot}` */
  readonly id: string
  readonly model: string
  readonly state: JsonObject
  /** Keys are already namespaced `${ruleId}::${qid}`. */
  readonly questions: Readonly<Record<string, Question>>
}

export interface JudgeUsage {
  readonly input_tokens: number
  readonly output_tokens: number
}

export interface JudgeResponse {
  readonly answers: Readonly<Record<string, Answer>>
  readonly model?: string
  readonly usage?: JudgeUsage
}

export interface Judge {
  /**
   * Returns null to decline the request (dry-run). The runner records the
   * request, marks it unjudged and never calls `decide`.
   */
  judge(request: JudgeRequest): Promise<JudgeResponse | null>
}

export class JudgeError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "JudgeError"
    this.status = status
  }
}
