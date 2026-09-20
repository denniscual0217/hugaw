import { useMemo } from "react"
import { useQuery } from "./_query"

export function Results({ term }) {
  const key = useMemo(() => ({ term }), [term])
  const rows = useQuery(key)
  return <ul>{rows.length}</ul>
}
