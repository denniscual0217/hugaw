import { useMemo, useState } from "react"

export function Counter({ n }) {
  const initial = useMemo(() => ({ n }), [n])
  const [state] = useState(initial)
  return <span>{state.n}</span>
}
