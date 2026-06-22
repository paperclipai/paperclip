import type { AgentMemoryStatus, AgentMemoryType } from "../constants.js";

/**
 * A single durable, per-agent long-term memory (issue #6).
 * Postgres is the source of truth; MEMORY.md is a rendered view of `active` rows.
 */
export interface AgentMemory {
  id: string;
  companyId: string;
  agentId: string;
  type: AgentMemoryType;
  title: string;
  body: string;
  status: AgentMemoryStatus;
  confidence: number;
  tags: string[];
  sourceRunId: string | null;
  sourceIssueId: string | null;
  sourceCommentId: string | null;
  recallCount: number;
  lastRecalledAt: Date | null;
  supersedesMemoryId: string | null;
  supersededByMemoryId: string | null;
  createdByActorType: string | null;
  createdByActorId: string | null;
  createdAt: Date;
  updatedAt: Date;
  forgottenAt: Date | null;
}

/** Audit record for a consolidation ("dreaming") pass over one agent. */
export interface AgentMemoryConsolidationRun {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  ingested: number;
  staged: number;
  promoted: number;
  forgotten: number;
  costCents: number;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}
