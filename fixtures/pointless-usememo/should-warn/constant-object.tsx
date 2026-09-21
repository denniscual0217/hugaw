import { useMemo } from "react"

function format(amount, currency) {
  return `${currency}${amount.toFixed(2)}`
}

export function Price({ amount, currency }) {
  const label = useMemo(() => ({ text: format(amount, currency) }), [amount, currency])
  return <span className="price">{label.text}</span>
}
