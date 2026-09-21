import { memo, useMemo } from "react"

const Child = memo(function Child({ data }) {
  return <i>{data.v}</i>
})

export function Parent({ v }) {
  const data = useMemo(() => ({ v }), [v])
  return <Child data={data} />
}
