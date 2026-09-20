// Moved here from should-warn/ when the cost rubric changed, not because
// the code changed: `transform(items)` over an unbounded prop array is
// exactly what rubric level 2 describes, and the model now puts 60% there.
import { useMemo } from "react"

export function Row({ items, transform }) {
  const label = useMemo(() => transform(items), [items, transform])
  return <span>{label}</span>
}
