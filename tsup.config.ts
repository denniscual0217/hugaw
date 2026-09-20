import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
    bin: "src/bin.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
})
