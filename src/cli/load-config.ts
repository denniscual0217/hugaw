import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createJiti } from "jiti"
import { defaultConfigObject } from "./defaults.js"

const CONFIG_NAMES = ["hugaw.config.ts", "hugaw.config.mts", "hugaw.config.js", "hugaw.config.mjs"]

export interface LoadedConfig {
  readonly raw: Record<string, unknown>
  /** Absolute path of the config file, or null when built-in defaults were used. */
  readonly path: string | null
}

export function findConfig(cwd: string): string | null {
  let dir = resolve(cwd)
  const { root } = parse(dir)
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    if (dir === root) return null
    dir = dirname(dir)
  }
}

/**
 * Our own entry points, whether we are running from `dist/` or from `src/`.
 * A config file does `import { defineConfig } from "hugaw"`, which must
 * resolve even when hugaw is not installed in the linted project (the dogfood
 * case). Aliasing to the very files already loaded also avoids a second copy
 * of the module — two `definePlugin` identities would fail `isPlugin`.
 */
function resolveSelf(entry: "index" | "react"): string | null {
  const candidates = [
    new URL(`./${entry}.js`, import.meta.url), // bundled: dist/bin.js -> dist/index.js
    new URL(`../${entry}.ts`, import.meta.url), // source: src/cli/ -> src/index.ts
    new URL(`../${entry}.js`, import.meta.url),
  ]
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    if (existsSync(path)) return path
  }
  return null
}

function selfAliases(): Record<string, string> {
  const alias: Record<string, string> = {}
  const index = resolveSelf("index")
  const reactEntry = resolveSelf("react")
  if (index) alias["hugaw"] = index
  if (reactEntry) alias["hugaw/react"] = reactEntry
  return alias
}

export async function loadConfig(cwd: string, explicit?: string): Promise<LoadedConfig> {
  const path =
    explicit === undefined
      ? findConfig(cwd)
      : isAbsolute(explicit)
        ? explicit
        : resolve(cwd, explicit)

  if (path === null) return { raw: defaultConfigObject(), path: null }
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`)

  const jiti = createJiti(import.meta.url, { alias: selfAliases() })
  const loaded = await jiti.import(path, { default: true })
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    throw new Error(`Config file ${path} must export default an object`)
  }
  return { raw: loaded as Record<string, unknown>, path }
}
