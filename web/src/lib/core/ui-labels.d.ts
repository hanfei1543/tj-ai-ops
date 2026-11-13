// ui-labels.js 的类型声明（TS 侧只需类型，不重复实现逻辑）

export interface StatusInfo {
  label: string
  cls: string
  raw: string
  known: boolean
  hint: string
}

export interface TaskInfo {
  label: string
  raw: string
  irs_confirmed: false
  hint: string
}

export function poStatusInfo(
  status: unknown,
  poType: unknown,
): { label: string; cls: string; raw: string; hint: string }
export function eventStatusInfo(status: unknown): StatusInfo
export function taskStatusInfo(status: unknown): TaskInfo
export function warningLabel(code: unknown): string
export function exceptionLabel(code: unknown): string
export function roleLabel(role: unknown): string

export const ROLE_LABELS: Record<string, string>
