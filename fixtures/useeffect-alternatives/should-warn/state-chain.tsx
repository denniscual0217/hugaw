import { useEffect, useState } from "react"

/**
 * Two links of one chain: a click sets `count`, an effect derives `isTen`
 * from it, and a second effect derives `message` from that.
 *
 * **The `onClick` is load-bearing — do not remove it.** It is what makes this
 * a chain rather than two plain derivations: with a handler starting it, the
 * fix is to compute the whole transition where the click happens. Delete the
 * button and `count` is never written, both effects become pure functions of
 * their inputs, and the verdict correctly changes to `render_computation` —
 * which looks like a regression and is not.
 */
export function Counter() {
  const [count, setCount] = useState(0)
  const [isTen, setIsTen] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (count === 10) setIsTen(true)
  }, [count])

  useEffect(() => {
    if (isTen) setMessage("Reached ten!")
  }, [isTen])

  return (
    <div>
      <button onClick={() => setCount(count + 1)}>+1</button>
      {message}
    </div>
  )
}
