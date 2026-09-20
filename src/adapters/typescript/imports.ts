import { Node, SyntaxKind } from "ts-morph"

export interface ImportSource {
  /** The module specifier, e.g. "react". */
  readonly module: string
  /** The name as exported by that module, e.g. "useMemo". */
  readonly name: string
  /** True for `React.useMemo` reached through a default or namespace import. */
  readonly viaNamespace: boolean
}

function declarationOf(node: Node): Node | undefined {
  const symbol = node.getSymbol()
  if (!symbol) return undefined
  const direct = symbol.getDeclarations()[0]
  if (direct) return direct
  return symbol.getAliasedSymbol()?.getDeclarations()[0]
}

/**
 * Where an expression's callee came from, resolved *syntactically*.
 *
 * Deliberately never touches the type checker's types: fixtures (and most real
 * repos being linted ad hoc) have no @types/react, so `getType()` would yield
 * `any` and every React check would silently fail open.
 */
export function importSourceOf(expression: Node): ImportSource | null {
  if (Node.isIdentifier(expression)) {
    const declaration = declarationOf(expression)
    if (!declaration) return null
    if (Node.isImportSpecifier(declaration)) {
      // In ts-morph `getNameNode()` is the *exported* name and `getAliasNode()`
      // the local binding — the opposite of the compiler's propertyName/name.
      return {
        module: declaration.getImportDeclaration().getModuleSpecifierValue(),
        name: declaration.getNameNode().getText(),
        viaNamespace: false,
      }
    }
    if (Node.isImportClause(declaration)) {
      const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
      if (!importDeclaration) return null
      return {
        module: importDeclaration.getModuleSpecifierValue(),
        name: "default",
        viaNamespace: false,
      }
    }
    return null
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const left = expression.getExpression()
    if (!Node.isIdentifier(left)) return null
    const declaration = declarationOf(left)
    if (!declaration) return null
    if (Node.isNamespaceImport(declaration) || Node.isImportClause(declaration)) {
      const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
      if (!importDeclaration) return null
      return {
        module: importDeclaration.getModuleSpecifierValue(),
        name: expression.getNameNode().getText(),
        viaNamespace: true,
      }
    }
    return null
  }

  return null
}

function isImportBinding(node: Node): boolean {
  return (
    Node.isImportSpecifier(node) ||
    Node.isImportClause(node) ||
    Node.isNamespaceImport(node) ||
    Node.isImportEqualsDeclaration(node)
  )
}

/**
 * The declaration an identifier points at, following import aliases across
 * files. `getDefinitionNodes()` comes back empty for untyped modules, so the
 * aliased symbol is the fallback that makes cross-file `export default
 * memo(Child)` resolvable without @types/react.
 */
export function resolveDeclaration(node: Node): Node | undefined {
  if (Node.isIdentifier(node)) {
    const external = node.getDefinitionNodes().find((d) => !isImportBinding(d))
    if (external) return external
  }
  const symbol = node.getSymbol()
  if (!symbol) return undefined
  const aliased = symbol.getAliasedSymbol()
  const declarations = (aliased ?? symbol).getDeclarations()
  return declarations.find((d) => !isImportBinding(d)) ?? declarations[0]
}
