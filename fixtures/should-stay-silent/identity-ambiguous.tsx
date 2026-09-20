import { useMemo } from "react"
import { trackIdentity } from "./_track"

export function Panel({ id }) {
  const value = useMemo(() => ({ id }), [id])
  trackIdentity(value)
  return <section>{value.id}</section>
}
