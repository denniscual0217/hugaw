import { useState, useEffect } from "react"
import { summarize, fetchProduct } from "./_lib"

/* 1a — derived state, computed INLINE. The control: both tools report this. */
export function TotalsInline({ rows }) {
  const [total, setTotal] = useState(0)
  useEffect(() => {
    setTotal(rows.map((r) => r.total).reduce((a, b) => a + b, 0))
  }, [rows])
  return <span>{total}</span>
}

/* 1b — the same derived state, but through an IMPORTED function. Identical
      shape, identical prop, identical setter. A static rule cannot read
      `summarize`, so it goes quiet; hugaw inlines the body when it can and
      says so when it cannot. This pair is the whole difference in two files. */
export function TotalsImported({ rows }) {
  const [total, setTotal] = useState(0)
  useEffect(() => {
    setTotal(summarize(rows))
  }, [rows])
  return <span>{total}</span>
}

/* 2 — data fetching. The plugin has no fetch rule: `no-derived-state` needs the
      setter's arguments to trace to props or state, and `.then(setProduct)`
      hands the setter over instead of calling it. */
export function ProductPage({ productId }) {
  const [product, setProduct] = useState(null)
  useEffect(() => {
    fetchProduct(productId).then(setProduct)
  }, [productId])
  return <div>{product?.name}</div>
}

/* 3 — editable state that follows a prop. `name` is written in the effect AND
      in the change handler, so "compute it during render" deletes the user's
      ability to type. Currently BOTH tools give breaking advice; hugaw has the
      handler write in its payload and picks the wrong option anyway. */
export function NameField({ user }) {
  const [name, setName] = useState("")
  useEffect(() => {
    setName(user.name)
  }, [user.id])
  return <input value={name} onChange={(e) => setName(e.target.value)} />
}

/* 4 — a genuine synchronisation. Neither tool should say anything.
      A false positive here tells an agent to delete working code. */
export function Presence({ roomId }) {
  const [online, setOnline] = useState([])
  useEffect(() => {
    const socket = new WebSocket(`/room/${roomId}`)
    socket.onmessage = (e) => setOnline((prev) => [...prev, JSON.parse(e.data)])
    return () => socket.close()
  }, [roomId])
  return <ul>{online.map((u) => <li key={u.id}>{u.name}</li>)}</ul>
}
