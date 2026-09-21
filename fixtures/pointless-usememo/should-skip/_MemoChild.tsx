import { memo } from "react"

function Child({ data }) {
  return <i>{data.v}</i>
}

export default memo(Child)
