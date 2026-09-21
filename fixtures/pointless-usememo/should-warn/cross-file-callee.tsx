import { useMemo } from "react"
import { slugify } from "./_helpers"

export function Slug({ title }) {
  const slug = useMemo(() => slugify(title), [title])
  return <code>{slug}</code>
}
