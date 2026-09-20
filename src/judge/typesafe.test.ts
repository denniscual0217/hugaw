import { describe, expect, it } from "vitest"
import { JudgeError } from "../core/index.js"
import { noul, score } from "../core/index.js"
import type { JudgeRequest } from "../core/index.js"
import { TypeSafeJudge } from "./typesafe.js"

interface Capture {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(
  body: unknown,
  status = 200,
): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Capture[] } {
  const calls: Capture[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    },
  }
}

const request: JudgeRequest = {
  id: "unit#0",
  model: "jev-1.13.0",
  state: { memo_call: { source: "useMemo(() => 1, [])" } },
  questions: {
    "react/pointless-usememo::cost": score("How expensive?", ["cheap", "medium", "dear"]),
    "react/pointless-usememo::identity_matters": noul("Does identity matter?"),
  },
}

const goodBody = {
  model: "jev-1.13.0",
  answers: {
    "react/pointless-usememo::cost": {
      type: "score",
      score: 0.11,
      confidence: 0.89,
      legend: { "0": "cheap", "1": "medium", "2": "dear" },
      probabilities: { "0": 0.89, "1": 0.11, "2": 0 },
    },
    "react/pointless-usememo::identity_matters": { type: "noul", noul: 0.08 },
  },
  usage: { input_tokens: 606, output_tokens: 0 },
}

describe("TypeSafeJudge", () => {
  it("sends state, model and namespaced questions as the request body", async () => {
    const { fetch, calls } = fakeFetch(goodBody)
    const judge = new TypeSafeJudge({ apiKey: "test-key", fetch })
    await judge.judge(request)

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(calls[0]!.init?.method).toBe("POST")

    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer test-key")

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body["model"]).toBe("jev-1.13.0")
    expect(body["state"]).toEqual(request.state)
    expect(Object.keys(body["questions"] as object)).toEqual([
      "react/pointless-usememo::cost",
      "react/pointless-usememo::identity_matters",
    ])
    // Core's question shapes go over the wire unmapped.
    expect((body["questions"] as Record<string, unknown>)["react/pointless-usememo::cost"]).toEqual({
      type: "score",
      instructions: "How expensive?",
      criteria: ["cheap", "medium", "dear"],
    })
  })

  it("passes answers and usage through unchanged", async () => {
    const { fetch } = fakeFetch(goodBody)
    const judge = new TypeSafeJudge({ apiKey: "test-key", fetch })
    const response = await judge.judge(request)

    expect(response).not.toBeNull()
    expect(response!.answers["react/pointless-usememo::cost"]).toEqual(goodBody.answers["react/pointless-usememo::cost"])
    expect(response!.answers["react/pointless-usememo::identity_matters"]).toEqual({
      type: "noul",
      noul: 0.08,
    })
    expect(response!.usage).toEqual({ input_tokens: 606, output_tokens: 0 })
    expect(response!.model).toBe("jev-1.13.0")
  })

  it("rejects an answer whose type does not match its question", async () => {
    const drifted = {
      ...goodBody,
      answers: {
        ...goodBody.answers,
        "react/pointless-usememo::identity_matters": { type: "score", score: 1, confidence: 1 },
      },
    }
    const { fetch } = fakeFetch(drifted)
    const judge = new TypeSafeJudge({ apiKey: "test-key", fetch })
    await expect(judge.judge(request)).rejects.toThrow(/API schema drift/)
  })

  it("maps a 401 to a JudgeError carrying the status", async () => {
    const { fetch } = fakeFetch({ error: { message: "invalid api key" } }, 401)
    const judge = new TypeSafeJudge({ apiKey: "bad", fetch, maxRetries: 0 })
    await expect(judge.judge(request)).rejects.toBeInstanceOf(JudgeError)
    await judge.judge(request).catch((error: unknown) => {
      expect(error).toBeInstanceOf(JudgeError)
      expect((error as JudgeError).status).toBe(401)
      expect((error as JudgeError).message).toContain("TYPESAFE_API_KEY was rejected")
    })
  })

  it("reports a missing API key as a JudgeError, not a raw SDK error", () => {
    const previous = process.env["TYPESAFE_API_KEY"]
    delete process.env["TYPESAFE_API_KEY"]
    try {
      expect(() => new TypeSafeJudge({})).toThrow(JudgeError)
    } finally {
      if (previous !== undefined) process.env["TYPESAFE_API_KEY"] = previous
    }
  })
})
