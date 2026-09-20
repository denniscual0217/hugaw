import { createContext, useMemo } from "react"

const LocaleContext = createContext("en")

export function LocaleProvider({ locale, children }) {
  const value = useMemo(() => ({ locale }), [locale])
  return <LocaleContext value={value}>{children}</LocaleContext>
}
