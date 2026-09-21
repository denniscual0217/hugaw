import { useMemo } from "react"

/**
 * The factory calls a bare ambient global. `parseInt` resolves to a `.d.ts`
 * in another file, so the cross-file test alone would call it a blind spot
 * and caveat every finding like this one.
 */
export function PriceTag({ raw }) {
  const amount = useMemo(() => parseInt(raw, 10), [raw])

  return <span>{amount}</span>
}
