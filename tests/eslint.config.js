import ymnne from "eslint-plugin-react-you-might-not-need-an-effect"

/**
 * Every rule the plugin ships, all at "warn", so the comparison shows
 * everything it is capable of finding rather than a chosen subset.
 */
export default [
  {
    files: ["src/**/*.tsx", "src/**/*.jsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { ymnne },
    rules: Object.fromEntries(
      Object.keys(ymnne.rules ?? {}).map((r) => [`ymnne/${r}`, "warn"]),
    ),
  },
]
