import { defineConfig } from "hugaw"
import react from "hugaw/react"

export default defineConfig({
  files: ["tests/src/**/*.tsx"],
  ignores: ["**/node_modules/**", "**/_*.ts"],
  model: "jev-1.13.0",
  plugins: [react],
  rules: {
    "react/useeffect-alternatives": "warn",
    "react/pointless-usememo": "off",
  },
})
