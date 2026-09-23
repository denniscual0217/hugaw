import { useEffect, useState } from "react"

/**
 * The effect's body is a single call to a local helper, and the helper is
 * what sets the state.
 *
 * The payload has always carried `evaluateCount`'s body inlined in
 * `effect_body.resolved`, and the model has always read it. What the message
 * did not do was *say* so: it reported "calls `evaluateCount(count)`" and
 * then offered to delete state it appeared never to have seen.
 */
export function Counter() {
  const [count, setCount] = useState(0)
  const [finished, setFinished] = useState(false)

  function evaluateCount(value) {
    if (value >= 10) setFinished(true)
  }

  useEffect(() => {
    evaluateCount(count)
  }, [count])

  return <button onClick={() => setCount((c) => c + 1)}>{finished ? "Finished" : count}</button>
}
