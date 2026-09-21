import { useState } from "react"
import { useEffect } from "./_effect"

export function Banner({ text }) {
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    setSeen(true)
  }, [text])

  return <p>{seen ? text : null}</p>
}
