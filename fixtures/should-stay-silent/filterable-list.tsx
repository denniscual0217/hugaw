import { useMemo, useState } from "react"

export function FilterableList({ items }) {
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("all")

  const filteredItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.name.toLowerCase().includes(searchTerm.toLowerCase()) &&
          (selectedCategory === "all" || item.category === selectedCategory),
      ),
    [items, searchTerm, selectedCategory],
  )

  const categories = useMemo(() => new Set(items.map((item) => item.category)), [items])

  return (
    <div>
      <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
      <select
        value={selectedCategory}
        onChange={(event) => setSelectedCategory(event.target.value)}
      >
        {[...categories].map((category) => (
          <option key={category}>{category}</option>
        ))}
      </select>
      <ul>
        {filteredItems.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  )
}
