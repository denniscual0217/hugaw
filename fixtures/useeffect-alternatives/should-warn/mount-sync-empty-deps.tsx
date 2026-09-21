import { useEffect, useRef } from "react"
import { createEditor } from "./_editor"

export function MarkdownEditor({ initialValue }) {
  const hostRef = useRef(null)

  useEffect(() => {
    const editor = createEditor(hostRef.current, { value: initialValue })
    editor.focus()
    return () => editor.destroy()
  }, [])

  return <div ref={hostRef} />
}
