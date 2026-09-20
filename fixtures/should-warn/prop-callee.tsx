import { useMemo } from "react"

export function Row({ items, transform }) {
  const label = useMemo(() => transform(items), [items, transform])
  return <span>{label}</span>
}
