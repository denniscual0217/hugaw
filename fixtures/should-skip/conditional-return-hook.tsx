import { useMemo } from "react"

export function useLabel(name, enabled) {
  const label = useMemo(() => `Hi ${name}`, [name])
  return enabled ? label : null
}
