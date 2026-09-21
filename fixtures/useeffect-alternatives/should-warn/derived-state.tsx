import { useEffect, useState } from "react"

export function ProductList({ products }) {
  const [filtered, setFiltered] = useState([])

  useEffect(() => {
    setFiltered(products.filter((p) => p.inStock))
  }, [products])

  return (
    <ul>
      {filtered.map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  )
}
