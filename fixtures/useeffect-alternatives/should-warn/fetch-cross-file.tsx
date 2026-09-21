import { useEffect, useState } from "react"
import { fetchProduct } from "./_api"

export function ProductPage({ productId }) {
  const [product, setProduct] = useState(null)

  useEffect(() => {
    fetchProduct(productId).then(setProduct)
  }, [productId])

  return <h1>{product ? product.name : "…"}</h1>
}
