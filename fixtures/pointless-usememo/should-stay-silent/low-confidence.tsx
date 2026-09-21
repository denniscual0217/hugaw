import { useMemo } from "react"

export function Total({ items }) {
  const total = useMemo(() => items.reduce((sum, item) => sum + item.price, 0), [items])
  return <strong>{total}</strong>
}
