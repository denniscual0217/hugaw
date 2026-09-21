import { useMemo } from "react"

export function Ids({ items }) {
  const ids = useMemo(() => items.map((item) => item.id), [items])
  return <span>{ids.join(", ")}</span>
}
