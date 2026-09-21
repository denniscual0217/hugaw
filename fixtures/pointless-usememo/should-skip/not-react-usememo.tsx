import { useMemo } from "./my-memo"

export function Widget({ n }) {
  const value = useMemo(() => n * 2, [n])
  return <span>{value}</span>
}
