import type { Db } from "@paperclipai/db";

/** Context handed to every AGNB job handler. */
export interface AgnbJobContext {
  db: Db;
  /** Structured logger scoped to the job. */
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Abort signal — set when the scheduler is shutting down. */
  signal: AbortSignal;
}

export type AgnbJobResult = { ok: boolean; summary?: string } & Record<string, unknown>;

export type AgnbJobHandler = (ctx: AgnbJobContext) => Promise<AgnbJobResult>;

export interface AgnbJobDef {
  key: string;
  /** Run cadence in milliseconds. */
  intervalMs: number;
  handler: AgnbJobHandler;
  /** External deps that must be present (env keys); job skips if any missing. */
  requiresEnv?: string[];
  /** Default-disabled jobs only run on manual trigger. */
  enabledByDefault?: boolean;
}
