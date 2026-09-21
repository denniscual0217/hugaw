import { useMemo } from "react"

export function Panel({ n }) {
  const value = useMemo(() => ({ n }), [n])
  const [current] = useState(value)
  return <span>{current.n}</span>
}

// Shares React's name, shares none of its semantics.
function useState(initial) {
  return [initial, () => initial]
}
