import { useMemo } from "react"

function Label({ text }) {
  return <b>{text}</b>
}

export function Card({ name }) {
  const info = useMemo(() => `Card: ${name}`, [name])
  return <Label text={info} />
}
