import { defineConfig } from "hugaw";
import react from "hugaw/react";

export default defineConfig({
  files: ["sample/src/**/*.tsx"],
  ignores: ["**/node_modules/**", "**/_*.ts"],
  model: "jev-1.13.0",
  plugins: [react],
  rules: {
    "react/useeffect-alternatives": "error",
    "react/pointless-usememo": "off",
  },
});
