import type { Node } from "ts-morph"
import { importSourceOf } from "../../../adapters/typescript/imports.js"

/**
 * True when `expression` denotes React's `name` export, reached through any of
 * `import { name }`, `import * as React`, or `import React from "react"`.
 *
 * Purely syntactic on purpose — see `adapters/typescript/imports.ts`.
 */
export function isReactApi(expression: Node, name: string): boolean {
  const source = importSourceOf(expression)
  return source !== null && source.module === "react" && source.name === name
}
