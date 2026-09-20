import { createContext, useMemo } from "react"

const ThemeContext = createContext(null)

export function ThemeProvider({ theme, children }) {
  const value = useMemo(() => ({ theme }), [theme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
