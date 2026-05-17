export const PAPERCLIP_TASK_TYPES = [
  "architecture",
  "implementation",
  "bugfix",
  "test",
  "review",
  "documentation",
  "custom_process",
] as const;

export type PaperclipTaskType = (typeof PAPERCLIP_TASK_TYPES)[number];

export interface PaperclipTask {
  id?: string | null;
  type?: PaperclipTaskType | string | null;
  source?: string | null;
  originalGoal?: string | null;
  approvedScope?: string | null;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  allowedCommands?: string[];
  forbiddenCommands?: string[];
  requestedCommands?: string[];
  contextFiles?: string[];
  reason?: string | null;
  requiresProductionDeployment?: boolean;
  securitySensitive?: boolean;
  explicitApproval?: boolean;
}

export function normalizePaperclipTaskType(value: unknown): PaperclipTaskType | null {
  if (typeof value !== "string") return null;
  return PAPERCLIP_TASK_TYPES.includes(value as PaperclipTaskType)
    ? value as PaperclipTaskType
    : null;
}
