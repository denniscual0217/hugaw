import { existsSync } from "node:fs"
import { join } from "node:path"

// Live tests (HUGAW_LIVE=1) need TYPESAFE_API_KEY; loadEnvFile never overwrites
// variables already present, so a CI-provided key still wins.
const envPath = join(process.cwd(), ".env")
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath)
  } catch {
    /* a malformed .env must not break the unit suite */
  }
}
