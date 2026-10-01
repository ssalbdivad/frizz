import type { EmbedEditorContextMessage } from "@frizz/shared"
import { proxy, useSnapshot } from "valtio"

// WHAT THE EDITOR AROUND THE SIDEBAR HAS OPEN — the latest `frizz:editor-context` (packages/shared/src/
// embed-protocol.ts), kept for the context bar over the sidebar's composers. Paths and line numbers only:
// the selected text crosses when the human adds it (`frizz:add-context`). Empty outside embed mode, where
// nothing ever writes it.

export interface EditorContextState {
  active: EmbedEditorContextMessage["active"]
  open: EmbedEditorContextMessage["open"]
}

export const editorContext = proxy<EditorContextState>({ active: null, open: [] })

/** A `frizz:editor-context` from the host replaces the last one whole. */
export function setEditorContext(message: EmbedEditorContextMessage): void {
  editorContext.active = message.active
  editorContext.open = message.open
}

export function useEditorContext(): EditorContextState {
  return useSnapshot(editorContext) as EditorContextState
}
