import { useEffect, useRef, useState } from "react";

function Modal({ isOpen }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  return isOpen ? <input ref={inputRef} /> : null;
}

// function Toggle({ onChange }) {
//   const [isOn, setIsOn] = useState(false);
//
//   useEffect(() => {
//     onChange(isOn);
//   }, [isOn, onChange]);
//
//   function handleClick() {
//     setIsOn(!isOn);
//   }
//
//   return <button onClick={handleClick}>{isOn ? "ON" : "OFF"}</button>;
// }

// import { useState, useEffect } from "react";
// import { summarize, fetchProduct } from "./_lib";

// export function TotalsInline({ rows }) {
//   const [total, setTotal] = useState(0);
//   useEffect(() => {
//     setTotal(rows.map((r) => r.total).reduce((a, b) => a + b, 0));
//   }, [rows]);
//   return <span>{total}</span>;
// }
//
// export function TotalsImported({ rows }) {
//   const [total, setTotal] = useState(0);
//   useEffect(() => {
//     setTotal(summarize(rows));
//   }, [rows]);
//   return <span>{total}</span>;
// }
//
// export function ProductPage({ productId }) {
//   const [product, setProduct] = useState(null);
//   useEffect(() => {
//     fetchProduct(productId).then(setProduct);
//   }, [productId]);
//   return <div>{product?.name}</div>;
// }
//
// export function NameField({ user }) {
//   const [name, setName] = useState("");
//   useEffect(() => {
//     setName(user.name);
//   }, [user.id]);
//   return <input value={name} onChange={(e) => setName(e.target.value)} />;
// }

export function Presence({ roomId }) {
  const [online, setOnline] = useState([]);
  useEffect(() => {
    const socket = new WebSocket(`/room/${roomId}`);
    socket.onmessage = (e) =>
      setOnline((prev) => [...prev, JSON.parse(e.data)]);
    return () => socket.close();
  }, [roomId]);
  return (
    <ul>
      {online.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
