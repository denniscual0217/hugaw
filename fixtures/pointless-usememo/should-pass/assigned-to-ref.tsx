// The escape-assignment path lost its static protection when `skip` was
// deleted; this is the only fixture covering it, so it guards the description
// that now has to carry the fact instead.
import { useMemo, useRef } from "react"

export function Tracker({ id }) {
  const previous = useRef(null)
  const value = useMemo(() => ({ id }), [id])
  previous.current = value
  return <span>{id}</span>
}
