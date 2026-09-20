import { useEffect, useMemo } from "react"

export function Tracker({ id }) {
  const payload = useMemo(() => ({ id }), [id])

  useEffect(() => {
    report(payload)
  }, [payload])

  return null
}

function report(value) {
  return value
}
