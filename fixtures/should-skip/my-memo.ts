export function useMemo(factory, deps) {
  return [factory(), deps]
}
