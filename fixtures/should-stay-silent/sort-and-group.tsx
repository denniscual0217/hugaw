import { useMemo } from "react"

export function UserList({ users }) {
  const sorted = useMemo(() => [...users].sort((a, b) => a.name.localeCompare(b.name)), [users])
  return (
    <ul>
      {sorted.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}
