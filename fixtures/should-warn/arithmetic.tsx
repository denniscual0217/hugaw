import { useMemo } from "react"

export function Area({ width, height }) {
  const area = useMemo(() => width * height, [width, height])
  return <span>{area}</span>
}
