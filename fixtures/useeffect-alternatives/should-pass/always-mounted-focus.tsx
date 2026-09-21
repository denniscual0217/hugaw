import { useEffect, useRef } from "react"

/**
 * The negative for `ref_callback`, and the reason its criterion is narrow.
 *
 * This looks identical at the call site — a ref, a focus, one dependency —
 * but the input is rendered unconditionally, so the node never goes away. A
 * ref callback would fire once at mount and never again, silently dropping
 * every later tab change. Measured live: `keep_effect` 0.85, `ref_callback`
 * 0.15.
 */
export function SearchPanel({ activeTab }) {
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [activeTab])

  return <input ref={inputRef} placeholder="Search" />
}
