import { execFile } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { beforeAll, describe, expect, it } from "vitest"

const run = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, "..")
const BIN = join(REPO_ROOT, "dist", "bin.js")
const SRC = join(REPO_ROOT, "src")
const TSUP = join(REPO_ROOT, "node_modules", ".bin", "tsup")

function newestMtime(dir: string): number {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .reduce((newest, f) => Math.max(newest, statSync(join(dir, f)).mtimeMs), 0)
}

/**
 * These tests exercise the *built* CLI, so a stale `dist/` would quietly test
 * yesterday's code. Rebuild whenever any source file is newer than the bundle.
 */
async function ensureFreshBuild(): Promise<void> {
  const fresh = existsSync(BIN) && statSync(BIN).mtimeMs >= newestMtime(SRC)
  if (fresh) return
  await run(TSUP, [], { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 })
}

/** The CSI prefix every ANSI colour sequence starts with. */
const ANSI_CSI = `${String.fromCharCode(27)}[`

/** These fixtures produce no candidate, so the key is never used. */
const NO_NETWORK = { TYPESAFE_API_KEY: "unused-by-these-cases" }

interface Result {
  code: number
  stdout: string
  stderr: string
}

async function hugaw(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run("node", [BIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      maxBuffer: 20 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

describe("hugaw CLI (built)", () => {
  // 60s: a cold tsup run (including the dts pass) is a few seconds.
  beforeAll(async () => {
    await ensureFreshBuild()
  }, 60_000)

  it("prints its version", async () => {
    const { code, stdout } = await hugaw(["--version"])
    expect(code).toBe(0)
    expect(stdout).toContain("hugaw/0.1.0")
  })

  it("--dry-run prints the payload, calls nothing and needs no API key", async () => {
    const { code, stdout } = await hugaw(
      ["fixtures/pointless-usememo/should-warn/constant-object.tsx", "--dry-run"],
      { TYPESAFE_API_KEY: "" },
    )
    expect(code).toBe(0)

    const payload = JSON.parse(stdout) as {
      requests: { request: { state: Record<string, unknown>; questions: Record<string, unknown> } }[]
      stats: { candidates: number; judged: number }
    }
    expect(payload.requests.length).toBe(1)
    expect(Object.keys(payload.requests[0]!.request.state).sort()).toEqual([
      "callee_sources",
      "component_source",
      "memo_call",
      "value_usages",
    ])
    expect(Object.keys(payload.requests[0]!.request.questions).sort()).toEqual([
      "react/pointless-usememo::cost",
      "react/pointless-usememo::identity_matters",
    ])
    expect(payload.stats.candidates).toBe(1)
    expect(payload.stats.judged).toBe(0)
  })

  it("a file with no candidate makes no request at all", async () => {
    // `skip` is gone by design; `select` is what still costs nothing.
    const { code, stdout } = await hugaw(
      ["fixtures/pointless-usememo/not-a-candidate/not-react-usememo.tsx", "--dry-run"],
      { TYPESAFE_API_KEY: "" },
    )
    expect(code).toBe(0)
    const payload = JSON.parse(stdout) as {
      requests: unknown[]
      stats: { candidates: number; judged: number }
    }
    expect(payload.requests).toEqual([])
    expect(payload.stats.candidates).toBe(0)
    expect(payload.stats.judged).toBe(0)
  })

  it("--format json stays a bare LintResult array, with stats on stderr", async () => {
    // The contract CI consumers index into. The usage numbers deliberately do
    // not appear here — they went into a second formatter instead of being
    // added as a sibling key, which would have broken every such consumer.
    const { code, stdout, stderr } = await hugaw(
      ["fixtures/pointless-usememo/not-a-candidate/not-react-usememo.tsx", "--format", "json"],
      NO_NETWORK,
    )
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("[]")
    expect(JSON.parse(stdout)).toBeInstanceOf(Array)
    expect(stdout).not.toContain("metadata")
    expect(stdout).not.toContain("tokens")
    expect(stderr).toContain("0 candidates, 0 skipped statically, 0 judged")
  })

  it("--format json-with-metadata wraps the same array and adds usage", async () => {
    const { code, stdout, stderr } = await hugaw(
      [
        "fixtures/pointless-usememo/not-a-candidate/not-react-usememo.tsx",
        "--format",
        "json-with-metadata",
      ],
      NO_NETWORK,
    )
    expect(code).toBe(0)

    const payload = JSON.parse(stdout) as {
      results: unknown[]
      metadata: {
        rulesMeta: Record<string, unknown>
        usage: Record<string, unknown>
      }
    }
    expect(payload.results).toEqual([])
    expect(payload.metadata.rulesMeta["react/pointless-usememo"]).toBeDefined()
    // Nothing was judged, so there is no model and therefore no price: the
    // cost keys are absent rather than zero.
    expect(payload.metadata.usage).toEqual({
      model: null,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    // stdout is still pure JSON, so `| jq` works for both formats.
    expect(stdout.trimStart().startsWith("{")).toBe(true)
    expect(stderr).toContain("candidates")
  })

  it("says nothing about cost on a run that spent nothing", async () => {
    const { stdout } = await hugaw(
      ["fixtures/pointless-usememo/not-a-candidate/not-react-usememo.tsx"],
      NO_NETWORK,
    )
    expect(stdout).toContain("0 candidates, 0 skipped statically, 0 judged")
    expect(stdout).not.toContain("tokens")
    expect(stdout).not.toContain("$")
  })

  it("exits 2 with a clear message when the API key is missing", async () => {
    const { code, stderr } = await hugaw(["fixtures/pointless-usememo/should-warn/arithmetic.tsx"], {
      TYPESAFE_API_KEY: "",
    })
    expect(code).toBe(2)
    expect(stderr).toContain("TYPESAFE_API_KEY is not set")
  })

  it("exits 2 for an unknown rule", async () => {
    const { code, stderr } = await hugaw([
      "fixtures/pointless-usememo/should-warn/arithmetic.tsx",
      "--dry-run",
      "--rule",
      "react/nope",
    ])
    expect(code).toBe(2)
    expect(stderr).toContain('Unknown rule "react/nope"')
  })

  it("exits 2 for a formatter that is not installed", async () => {
    const { code, stderr } = await hugaw([
      "fixtures/pointless-usememo/not-a-candidate/not-react-usememo.tsx",
      "--format",
      "definitely-not-installed",
    ], NO_NETWORK)
    expect(code).toBe(2)
    expect(stderr).toContain("not installed: pnpm add -D eslint-formatter-definitely-not-installed")
  })

  it("prints pure JSON on stdout with stats on stderr", async () => {
    const { code, stdout, stderr } = await hugaw([
      "fixtures/pointless-usememo/not-a-candidate/not-react-usememo.tsx",
      "--format",
      "json",
    ], NO_NETWORK)
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual([])
    expect(stderr).toContain("0 candidates, 0 skipped statically, 0 judged")
  })

  it("writes no ANSI escapes when stdout is not a TTY", async () => {
    const { stdout } = await hugaw(
      ["fixtures/pointless-usememo/not-a-candidate/not-react-usememo.tsx"],
      NO_NETWORK,
    )
    expect(stdout.includes(ANSI_CSI)).toBe(false)
    expect(stdout).toContain("✓ no findings · 0 candidates, 0 skipped statically, 0 judged")
  })
})
