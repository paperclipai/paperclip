import type { Db } from "@paperclipai/db";

export type RunnableWakeRow = {
  id: string;
  companyId: string;
  agentId: string;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
  requestedAt: Date;
};

export type AgentSchedulerHost = {
  countRunningRunsForAgent(agentId: string): Promise<number>;
  appendSchedulerEvent(input: {
    companyId: string;
    agentId: string;
    wakeRequestId: string;
    issueId: string | null;
    kind: "enqueue" | "dequeue";
    reason: string;
    queueDepth: number;
    effectiveCapacity: number;
  }): Promise<void>;
};

export type AgentSchedulerWriter = {
  listRunnableWakes(agentId: string, limit: number): Promise<RunnableWakeRow[]>;
  parkWakeAsRunnable(input: {
    wakeRequestId: string;
    companyId: string;
    agentId: string;
    enqueueReason: string;
    schedulerMeta: Record<string, unknown>;
  }): Promise<void>;
  materializeRunnableWake(input: {
    wake: RunnableWakeRow;
    runId: string;
    dequeueReason: string;
  }): Promise<boolean>;
};

export type AgentSchedulerDb = Pick<Db, "select" | "insert" | "update" | "transaction">;
