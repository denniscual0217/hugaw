#!/usr/bin/env node
import { existsSync } from "node:fs"
import { join } from "node:path"

// Node 22 reads .env natively; it never overwrites variables already set, so a
// CI-provided TYPESAFE_API_KEY still wins over a checked-out .env.
const envPath = join(process.cwd(), ".env")
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath)
  } catch {
    /* a malformed .env must not stop the linter */
  }
}

const { main } = await import("./cli/main.js")
await main()
