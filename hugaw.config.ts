import { defineConfig } from "hugaw"
import react from "hugaw/react"

/**
 * hugaw linting its own fixtures — the dogfood config.
 *
 * `src/` has no React in it (that is the point of the architecture), so the
 * fixtures are what there is to lint here.
 */
export default defineConfig({
  files: ["fixtures/**/*.tsx"],
  ignores: ["**/node_modules/**", "**/dist/**", "**/_*.tsx"],
  model: "jev-1.13.0",
  plugins: [react],
  rules: {
    "react/pointless-usememo": "warn",
  },
})
