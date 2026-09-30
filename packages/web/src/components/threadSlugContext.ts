import { createContext } from "react"

// The slug of the thread whose transcript is rendering. See ChatView, which provides it and explains
// who reads it; it lives here so a component ChatView renders can read it without a module cycle.
export const ThreadSlugContext = createContext<string | null>(null)
