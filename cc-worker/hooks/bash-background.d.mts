export function hasEscapingBackgroundJob(raw: unknown): boolean
export function evaluateBashBackgroundHook(
  input: unknown,
  env?: Record<string, string | undefined>,
): Record<string, unknown>
export const LONG_FOREGROUND_MS: number
export function longForegroundContext(timeoutMs: number): string
export function isDirectHookExecution(argv1: unknown, moduleUrl: string, realpath?: (path: string) => string): boolean
