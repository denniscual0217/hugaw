export function slugify(value) {
  return String(value).toLowerCase().replace(/\s+/g, "-")
}
