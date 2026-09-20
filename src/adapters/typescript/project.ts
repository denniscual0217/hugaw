import { isAbsolute, resolve } from "node:path"
import { Project, ts } from "ts-morph"

export interface CreateProjectInput {
  readonly cwd: string
  readonly tsconfig?: string | undefined
  readonly files: readonly string[]
}

/**
 * Without a tsconfig we still need JSX parsing and permissive resolution:
 * fixtures import "react" with no @types/react installed. Every "is this from
 * react?" check is therefore syntactic (see `imports.ts`), never type-based.
 */
export function createProject(input: CreateProjectInput): Project {
  const { cwd, tsconfig, files } = input

  const project =
    tsconfig === undefined
      ? new Project({
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            jsx: ts.JsxEmit.Preserve,
            allowJs: true,
            strict: false,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
          },
          skipAddingFilesFromTsConfig: true,
        })
      : new Project({
          tsConfigFilePath: isAbsolute(tsconfig) ? tsconfig : resolve(cwd, tsconfig),
          skipAddingFilesFromTsConfig: true,
        })

  project.addSourceFilesAtPaths(files.map((f) => (isAbsolute(f) ? f : resolve(cwd, f))))
  // Pulls in same-project imports so cross-file callee/component resolution works.
  project.resolveSourceFileDependencies()
  return project
}
