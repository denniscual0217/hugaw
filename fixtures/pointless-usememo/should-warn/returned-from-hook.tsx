import { useMemo } from "react"

export function useLabel(name) {
  const label = useMemo(() => `Hi ${name}`, [name])
  return label
}
