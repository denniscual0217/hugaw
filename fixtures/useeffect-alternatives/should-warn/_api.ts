export function fetchProduct(id) {
  return fetch("/api/products/" + id).then((response) => response.json())
}
