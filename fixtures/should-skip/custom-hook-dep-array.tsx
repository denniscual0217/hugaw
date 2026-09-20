import { useMemo } from "react"
import { useDebounced } from "./_hooks"

export function Search({ term }) {
  const query = useMemo(() => ({ term }), [term])
  useDebounced(() => query, [query])
  return null
}
