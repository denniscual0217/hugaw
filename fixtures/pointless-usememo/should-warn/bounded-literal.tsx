import { useMemo } from "react"

export function Doubled() {
  const values = useMemo(() => [1, 2, 3].map((n) => n * 2), [])
  return <span>{values.join(", ")}</span>
}
