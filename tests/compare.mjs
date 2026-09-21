#!/usr/bin/env node
/** Runs both tools over src/ and prints their findings together. */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

const run = (cmd, args, cwd) => {
  try { return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }
  catch (e) { return (e.stdout ?? "") + (e.stderr ?? "") }
}
const rule = (label) => console.log("\n" + "─".repeat(72) + "\n" + label + "\n" + "─".repeat(72))

rule("eslint-plugin-react-you-might-not-need-an-effect  (all 9 rules)")
console.log(run("npx", ["eslint", "src", "--no-warn-ignored"], import.meta.dirname).trim() || "  no findings")

rule("hugaw  react/useeffect-alternatives")
if (!process.env["TYPESAFE_API_KEY"] && !existsSync(new URL("./.env", import.meta.url))) {
  console.log("  skipped — TYPESAFE_API_KEY is not set (export it, or put a .env here)")
} else {
  const root = new URL("..", import.meta.url).pathname
  console.log(run("node", ["dist/bin.js", "tests/src/**/*.tsx", "--config", "tests/hugaw.config.ts"], root).trim() || "  no findings")
}
console.log()
