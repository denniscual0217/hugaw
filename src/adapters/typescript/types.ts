import type {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  Node,
  SourceFile,
} from "ts-morph"
import type { LanguageTypes } from "../../core/types.js"

/** The function-like nodes hugaw treats as a "unit" (one component, one function). */
export type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration

export interface TsTypes extends LanguageTypes {
  readonly file: SourceFile
  readonly node: Node
  readonly unit: FunctionLike
}
