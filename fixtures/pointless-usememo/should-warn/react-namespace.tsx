import * as React from "react"

export function Greeting({ name }) {
  const greeting = React.useMemo(() => `Hello, ${name}`, [name])
  return <p>{greeting}</p>
}
