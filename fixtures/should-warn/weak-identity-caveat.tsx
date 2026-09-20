import { useMemo } from "react"

export function Badge({ level }) {
  const badge = useMemo(() => ({ level }), [level])
  return <span data-level={badge.level}>badge</span>
}
