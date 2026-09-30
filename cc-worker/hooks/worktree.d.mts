export const DEFAULT_WORKTREE_DIR: string
export function worktreeAddTargets(raw: unknown): { path: string; base?: string }[]
export function mainCheckoutOf(dir: string): string | undefined
export function worktreeRootFor(setting: string | undefined, repoDir: string, mainOf?: (dir: string) => string | undefined): string
export function isInside(root: string, candidate: string): boolean
export function worktreeSetting(argv: string[], env: Record<string, string | undefined>): string | undefined
export function evaluateWorktreeGuard(
  input: unknown,
  setting: string | undefined,
  mainOf?: (dir: string) => string | undefined,
): Record<string, unknown> | undefined
