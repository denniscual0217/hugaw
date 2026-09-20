import { useEffect, useMemo } from "react"

export function Chart({ n }) {
  const data = useMemo(() => ({ items: [n] }), [n])

  useEffect(() => {
    draw(data.items)
  }, [data.items])

  return null
}

function draw(items) {
  return items
}
