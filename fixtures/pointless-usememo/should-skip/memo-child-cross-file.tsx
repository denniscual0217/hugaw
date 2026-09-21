import { useMemo } from "react"
import MemoChild from "./_MemoChild"

export function Parent({ v }) {
  const data = useMemo(() => ({ v }), [v])
  return <MemoChild data={data} />
}
