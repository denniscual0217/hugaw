import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    setupFiles: ["test/setup.ts"],
  },
  resolve: {
    alias: {
      "hugaw/react": src("./src/react.ts"),
      hugaw: src("./src/index.ts"),
    },
  },
})
