import { describe, expect, it } from "vitest"
import { definePlugin, defineRule } from "./define.js"
import { noul } from "./questions.js"
import type { LanguageTypes } from "./types.js"

interface FakeTypes extends LanguageTypes {
  file: string
  node: string
  unit: string
}

const rule = defineRule<FakeTypes, undefined, { q: ReturnType<typeof noul> }, Record<string, never>>({
  name: "example",
  meta: { description: "example", defaultSeverity: "warn" },
  context: ["some_slice"],
  select: () => [],
  skip: () => null,
  ask: () => ({ q: noul("is it?") }),
  decide: () => null,
})

const slice = { scope: "unit", extract: () => "" } as const

describe("definePlugin slice names", () => {
  it("accepts a plugin whose rules declare slices it provides", () => {
    expect(() =>
      definePlugin<FakeTypes>({ id: "p", language: "l", rules: [rule], slices: { some_slice: slice } }),
    ).not.toThrow()
  })

  it("rejects a context slice the plugin does not provide", () => {
    expect(() =>
      definePlugin<FakeTypes>({ id: "p", language: "l", rules: [rule], slices: {} }),
    ).toThrow(/does not provide/)
  })

  it("rejects a slice name that is not an identifier", () => {
    expect(() =>
      definePlugin<FakeTypes>({
        id: "p",
        language: "l",
        rules: [],
        slices: { "not-an-identifier": slice },
      }),
    ).toThrow(/not a valid identifier/)
  })

  it("rejects a slice that would collide with a key the runner writes", () => {
    // `project_notes` is injected by the runner from config, not by a plugin.
    expect(() =>
      definePlugin<FakeTypes>({ id: "p", language: "l", rules: [], slices: { project_notes: slice } }),
    ).toThrow(/reserved by the runner/)
  })
})
