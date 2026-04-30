import type { Db } from "@paperclipai/db";

export type NotifyChannel = "silent" | "threshold" | "telegram";
export type CheckStatus = "ok" | "warn" | "error";
export type ThresholdSeverity = "warn" | "error";

export interface CheckCtx {
  db: Db;
  now: () => Date;
  logger: CheckLogger;
}

export interface CheckLogger {
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
}

export interface CheckResult {
  status: CheckStatus;
  findings: number;
  payload: Record<string, unknown>;
  summary: string;
}

export interface CheckDef {
  name: string;
  schedule: string;
  notify: NotifyChannel;
  thresholdSeverity?: ThresholdSeverity;
  run: (ctx: CheckCtx) => Promise<CheckResult>;
}
