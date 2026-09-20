import { useMemo } from "react"

export function Banner({ a, b }) {
  const show = useMemo(() => a && b, [a, b])
  return show && <em>yes</em>
}
