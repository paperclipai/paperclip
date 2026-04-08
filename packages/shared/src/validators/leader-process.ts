import { z } from "zod";

/** Allowed statuses for a leader_processes row. */
export const LEADER_PROCESS_STATUSES = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
] as const;
export type LeaderProcessStatus = (typeof LEADER_PROCESS_STATUSES)[number];

export const leaderProcessStatusSchema = z.enum(LEADER_PROCESS_STATUSES);

/** POST /cli/stop { timeoutMs? } */
export const stopLeaderProcessSchema = z.object({
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});
export type StopLeaderProcess = z.infer<typeof stopLeaderProcessSchema>;

/** POST /cli/start — no body (all params come from path). */
export const startLeaderProcessSchema = z.object({}).strict();
export type StartLeaderProcess = z.infer<typeof startLeaderProcessSchema>;

/** GET /cli/logs?kind=out|err&lines=N */
export const leaderProcessLogQuerySchema = z.object({
  kind: z.enum(["out", "err"]).default("out"),
  lines: z.coerce.number().int().positive().max(500).default(50),
});
export type LeaderProcessLogQuery = z.infer<typeof leaderProcessLogQuerySchema>;

/** Response payload shape (informational, not for request validation) */
export interface LeaderProcessResponse {
  id: string;
  companyId: string;
  agentId: string;
  sessionId: string | null;
  status: LeaderProcessStatus;
  pm2Name: string | null;
  pm2PmId: number | null;
  pid: number | null;
  agentKeyId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastHeartbeatAt: string | null;
  exitCode: number | null;
  exitReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
