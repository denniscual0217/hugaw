import { useMemo } from "react"

export function Receipt({ amount, currency, compact }) {
  const label = useMemo(() => `${currency}${amount.toFixed(2)}`, [amount, currency])

  if (compact) {
    return <span>{label}</span>
  }

  return (
    <div className="receipt">
      <span title={label}>total</span>
    </div>
  )
}
