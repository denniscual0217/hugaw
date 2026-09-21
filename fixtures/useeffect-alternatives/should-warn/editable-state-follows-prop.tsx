import { useEffect, useState } from "react"

/**
 * The trap this rule exists to avoid giving in to. `name` is written by the
 * effect *and* by the change handler, so both "compute it during render" and
 * "store an id and derive it" would delete the user's ability to type.
 */
export function NameField({ user }) {
  const [name, setName] = useState("")

  useEffect(() => {
    setName(user.name)
  }, [user.id])

  return <input value={name} onChange={(e) => setName(e.target.value)} />
}
