/** Same name, not React's. `select` resolves the import, not the spelling. */
export function useEffect(effect: () => void, deps: unknown[]): void {
  effect()
  void deps
}
