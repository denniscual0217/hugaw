import { useEffect, useRef } from "react"

/**
 * `useState` is never imported, so it does not resolve to React's and the
 * component declares no state this rule can see. The finding must still
 * describe the call it *can* see, and must not offer to delete state it
 * never found.
 */
export function Cart({ items }) {
  const [total, setTotal] = useState(0)

  useEffect(() => {
    setTotal(items.reduce((sum, item) => sum + item.price, 0))
  }, [items])

  return <div>Total: {total}</div>
}
