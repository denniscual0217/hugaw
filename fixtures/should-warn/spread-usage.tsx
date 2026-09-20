import { useMemo } from "react"

export function Box({ color }) {
  const style = useMemo(() => ({ color }), [color])
  return <div {...style}>content</div>
}
