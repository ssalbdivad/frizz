import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useThreadProjectId } from "./threadApi.tsx"

/**
 * After a verb lands, re-read what the control was drawn from. Everything polls every project, so a
 * control asks for that poll now, and for its project's full board (Done, External), rather than showing
 * the old state for up to a poll. A control under no ThreadProjectScope (a fixture's) has nothing to
 * re-read. Shared by the rail row's verbs (Sidebar.tsx) and the card footer's pin (ThreadLifecycleFooter).
 */
export function useAfterScopedWrite(): () => void {
  const queryClient = useQueryClient()
  const projectId = useThreadProjectId()
  return useCallback(() => {
    if (!projectId) return
    void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    void queryClient.invalidateQueries({ queryKey: ["ofProject", projectId, "board"] })
  }, [queryClient, projectId])
}
