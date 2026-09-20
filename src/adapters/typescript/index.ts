import { isAbsolute, resolve } from "node:path"
import type { Node, Project, SourceFile } from "ts-morph"
import { defineAdapter } from "../../core/define.js"
import type { Location, Program } from "../../core/types.js"
import { locate } from "./locate.js"
import type { TsAdapterOptions } from "./options.js"
import { parseOptions } from "./options.js"
import { createProject } from "./project.js"
import type { FunctionLike, TsTypes } from "./types.js"
import { unitKey, unitName, unitOf } from "./units.js"

export class TsProgram implements Program<TsTypes> {
  readonly files: readonly SourceFile[]
  readonly #project: Project

  constructor(project: Project, files: readonly SourceFile[]) {
    this.#project = project
    this.files = files
  }

  /** Escape hatch for plugins that need the whole project (cross-file lookups). */
  get project(): Project {
    return this.#project
  }

  filePath(file: SourceFile): string {
    return file.getFilePath()
  }
  fileOf(node: Node): SourceFile {
    return node.getSourceFile()
  }
  unitOf(node: Node): FunctionLike | null {
    return unitOf(node)
  }
  unitKey(unit: FunctionLike): string {
    return unitKey(unit)
  }
  unitName(unit: FunctionLike): string {
    return unitName(unit)
  }
  locate(node: Node): Location {
    return locate(node)
  }
  nodeType(node: Node): string {
    return node.getKindName()
  }
  textOf(node: Node): string {
    return node.getText()
  }
  dispose(): void {
    for (const file of this.#project.getSourceFiles()) {
      this.#project.removeSourceFile(file)
    }
  }
}

export const typescriptAdapter = defineAdapter<TsTypes, TsAdapterOptions>({
  id: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  parseOptions,
  async load({ files, cwd, options }) {
    const project = createProject({ cwd, tsconfig: options.tsconfig, files })
    // Only the requested files are linted; dependencies were pulled in for
    // resolution alone and must not produce candidates of their own.
    const wanted = new Set(files.map((f) => (isAbsolute(f) ? f : resolve(cwd, f))))
    const sources = project.getSourceFiles().filter((f) => wanted.has(f.getFilePath()))
    return new TsProgram(project, sources)
  },
})

export type { TsAdapterOptions } from "./options.js"
export type { FunctionLike, TsTypes } from "./types.js"
export { importSourceOf, resolveDeclaration } from "./imports.js"
export type { ImportSource } from "./imports.js"
export { referencesWithin } from "./references.js"
export { isFunctionLike, unitKey, unitName, unitOf } from "./units.js"
export { locate } from "./locate.js"
export default typescriptAdapter
