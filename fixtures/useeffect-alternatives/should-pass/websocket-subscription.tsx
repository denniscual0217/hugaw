import { useEffect, useState } from "react"

function createConnection(roomId) {
  const socket = new WebSocket("wss://chat.example.com/" + roomId)
  return {
    connect() {
      socket.addEventListener("open", () => {})
    },
    on(event, handler) {
      socket.addEventListener(event, handler)
    },
    disconnect() {
      socket.close()
    },
  }
}

export function ChatRoom({ roomId }) {
  const [messages, setMessages] = useState([])

  useEffect(() => {
    const connection = createConnection(roomId)
    connection.on("message", (m) => setMessages((prev) => [...prev, m]))
    connection.connect()
    return () => connection.disconnect()
  }, [roomId])

  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{m.text}</li>
      ))}
    </ul>
  )
}
