import { useEffect, useRef } from "react"

/**
 * The input exists only while `isOpen` is true, so the effect's dependency is
 * a proxy for "has the node appeared". That is exactly when React runs a ref
 * callback, which makes the effect unnecessary.
 */
export function Modal({ isOpen }) {
  const inputRef = useRef(null)

  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])

  return isOpen ? <input ref={inputRef} /> : null
}
