import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";

export interface SeedSilentRunInput {
  db: ReturnType<typeof createDb>;
  now: Date;
  ageMs: number;
  pid?: number | null;
  sourceStatus?: "in_progress" | "done" | "cancelled";
}

export interface SeedSilentRunResult {
  companyId: string;
  managerId: string;
  coderId: string;
  issueId: string;
  runId: string;
  issuePrefix: string;
}

export async function seedSilentRun(input: SeedSilentRunInput): Promise<SeedSilentRunResult> {
  const { db } = input;
  const companyId = randomUUID();
  const managerId = randomUUID();
  const coderId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const startedAt = new Date(input.now.getTime() - input.ageMs);
  const sourceStatus = input.sourceStatus ?? "in_progress";

  await db.insert(companies).values({
    id: companyId,
    name: "Silence Detector Co",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values([
    {
      id: managerId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: coderId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      reportsTo: managerId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Long running silence-detector source",
    status: sourceStatus,
    priority: "medium",
    assigneeAgentId: coderId,
    issueNumber: 1,
    identifier: `${issuePrefix}-1`,
    originKind: "manual",
    updatedAt: startedAt,
    createdAt: startedAt,
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId: coderId,
    status: "running",
    invocationSource: "assignment",
    triggerDetail: "system",
    startedAt,
    processStartedAt: startedAt,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    contextSnapshot: { issueId },
    logBytes: 0,
    processPid: input.pid ?? null,
  });
  await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

  return { companyId, managerId, coderId, issueId, runId, issuePrefix };
}

/**
 * Generates a pid that is guaranteed not to be running on the current host —
 * we keep a counter that walks far above any normal pid space and call
 * process.kill(pid, 0) to confirm ESRCH.
 */
let __syntheticDeadPidCursor = 0x7fff_ff00;
export function freshDeadPid() {
  while (true) {
    __syntheticDeadPidCursor -= 1;
    const candidate = __syntheticDeadPidCursor;
    try {
      process.kill(candidate, 0);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ESRCH") return candidate;
    }
  }
}
