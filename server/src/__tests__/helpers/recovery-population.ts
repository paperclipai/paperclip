import { agents, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";

const HOUR = 60 * 60_000;

export type RecoveryPopulation = {
  agentIds: string[];
  pausedAgentId: string;
  terminatedAgentId: string;
  inReview: string[];
  inProgress: string[];
  todo: string[];
  withRecoveryAction: string[];
  terminated: string[];
};

export async function seedRecoveryPopulation(db: Db, companyId: string, counts: {
  agents: number; inReview: number; inProgress?: number; todo?: number; recoveryActions?: number; terminated?: number;
}): Promise<RecoveryPopulation> {
  const config = { adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "0"], cwd: process.cwd() },
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true } }, role: "engineer" };
  const [ceo] = await db.insert(agents).values({ ...config, companyId, name: "Chief", status: "idle" }).returning({ id: agents.id });
  const managers = await db.insert(agents).values(Array.from({ length: 6 }, (_, index) => ({ ...config, companyId,
    name: `Manager ${index}`, status: "idle", reportsTo: ceo!.id }))).returning({ id: agents.id });
  const workers = await db.insert(agents).values(Array.from({ length: Math.max(1, counts.agents - 9) }, (_, index) => ({ ...config,
    companyId, name: `Worker ${index}`, status: "idle", reportsTo: managers[index % managers.length]!.id }))).returning({ id: agents.id });
  const [paused] = await db.insert(agents).values({ ...config, companyId, name: "Paused worker", status: "paused",
    lifecycleHolds: ["manual"], reportsTo: managers[0]!.id }).returning({ id: agents.id });
  const [terminatedAgent] = await db.insert(agents).values({ ...config, companyId, name: "Former worker", status: "terminated",
    reportsTo: managers[1]!.id }).returning({ id: agents.id });
  const workerIds = workers.map(row => row.id);
  const finishedAt = new Date(Date.now() - HOUR);

  const insertTasks = async (count: number, values: (index: number) => Partial<typeof issues.$inferInsert>) => count === 0 ? []
    : (await db.insert(issues).values(Array.from({ length: count }, (_, index) => ({ companyId, title: `Task ${index}`,
      ...values(index) }))).returning({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })).map(row => row);

  const reviews = await insertTasks(counts.inReview, index => ({ status: "in_review",
    assigneeAgentId: workerIds[index % workerIds.length] }));
  if (reviews.length) await db.insert(heartbeatRuns).values(reviews.map(task => ({ companyId, agentId: task.assigneeAgentId!,
    status: "succeeded", runtimeMode: "native", startedAt: finishedAt, finishedAt, contextSnapshot: { issueId: task.id } })));
  const progressing = await insertTasks(counts.inProgress ?? 0, () => ({ status: "in_progress", assigneeAgentId: paused!.id }));
  if (progressing.length) await db.insert(heartbeatRuns).values(progressing.map(task => ({ companyId, agentId: paused!.id,
    status: "cancelled", errorCode: "agent_paused", startedAt: finishedAt, finishedAt, contextSnapshot: { issueId: task.id } })));
  const todo = await insertTasks(counts.todo ?? 0, () => ({ status: "todo", assigneeAgentId: paused!.id }));
  const terminated = await insertTasks(counts.terminated ?? 0, () => ({ status: "todo", assigneeAgentId: terminatedAgent!.id }));
  const withAction = reviews.slice(0, counts.recoveryActions ?? 0);
  if (withAction.length) await db.insert(issueRecoveryActions).values(withAction.map((task, index) => ({ companyId,
    sourceIssueId: task.id, kind: "missing_disposition", status: "active", ownerType: "agent", ownerAgentId: task.assigneeAgentId,
    cause: "seeded", fingerprint: `seeded-${index}`, nextAction: "seeded" })));
  return { agentIds: [ceo!.id, ...managers.map(row => row.id), ...workerIds, paused!.id, terminatedAgent!.id],
    pausedAgentId: paused!.id, terminatedAgentId: terminatedAgent!.id,
    inReview: reviews.map(row => row.id), inProgress: progressing.map(row => row.id), todo: todo.map(row => row.id),
    withRecoveryAction: withAction.map(row => row.id), terminated: terminated.map(row => row.id) };
}
