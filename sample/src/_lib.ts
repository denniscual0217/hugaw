// Bodies live here on purpose: a static rule cannot read them, hugaw inlines
// them into `effect_body.resolved` when they are in the same file and reports
// them as a blind spot when they are not.
export function summarize(rows: { total: number }[]) {
  return rows.map((r) => r.total).reduce((a, b) => a + b, 0)
}
export async function fetchProduct(id: string) {
  const res = await fetch(`/api/products/${id}`)
  return res.json()
}
