import { randomUUID } from "node:crypto";
import type { createDb } from "@paperclipai/db";
import {
  agents,
  companies,
  heartbeatRuns,
  issues,
  providerRateLimitBlockMembers,
  providerRateLimitBlocks,
} from "@paperclipai/db";

type Db = ReturnType<typeof createDb>;

export async function seedCompany(db: Db, overrides?: Partial<typeof companies.$inferInsert>) {
  const companyId = overrides?.id ?? randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
    ...overrides,
  });
  return companyId;
}

export async function seedAgent(
  db: Db,
  companyId: string,
  overrides?: Partial<typeof agents.$inferInsert>,
) {
  const agentId = overrides?.id ?? randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Claude",
    role: "engineer",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-4-6" },
    runtimeConfig: {},
    permissions: {},
    ...overrides,
  });
  return agentId;
}

export async function seedIssue(
  db: Db,
  companyId: string,
  overrides?: Partial<typeof issues.$inferInsert>,
) {
  const issueId = overrides?.id ?? randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Test issue",
    status: "in_progress",
    priority: "high",
    ...overrides,
  });
  return issueId;
}

export async function seedBlock(
  db: Db,
  companyId: string,
  overrides?: Partial<typeof providerRateLimitBlocks.$inferInsert>,
) {
  const [block] = await db
    .insert(providerRateLimitBlocks)
    .values({
      companyId,
      adapterType: "claude_local",
      limitKind: "five_hour",
      modelFamily: null,
      ...overrides,
    })
    .returning();
  return block!;
}

export async function seedBlockMember(
  db: Db,
  opts: {
    blockId: string;
    companyId: string;
    agentId: string;
    issueId?: string | null;
    originalAgentStatus?: string | null;
    releaseStatus?: string;
  },
) {
  await db.insert(providerRateLimitBlockMembers).values({
    blockId: opts.blockId,
    companyId: opts.companyId,
    agentId: opts.agentId,
    issueId: opts.issueId ?? null,
    originalAgentStatus: opts.originalAgentStatus ?? null,
    releaseStatus: opts.releaseStatus ?? "pending",
  });
}

export async function seedHeartbeatRun(
  db: Db,
  companyId: string,
  agentId: string,
  overrides?: Partial<typeof heartbeatRuns.$inferInsert>,
) {
  const runId = overrides?.id ?? randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "failed",
    ...overrides,
  });
  return runId;
}
