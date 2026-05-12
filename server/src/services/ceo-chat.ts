import { issues as issuesTable, agents as agentsTable, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

export interface CeoChatIssue {
  id: string;
  companyId: string;
  assigneeAgentId: string;
  isCeoChat: boolean;
  status: string;
  title: string;
}

export async function ensureCeoChatIssue(
  db: Db,
  companyId: string,
  ceoAgentId: string,
): Promise<CeoChatIssue> {
  const ceo = await db
    .select({ id: agentsTable.id, role: agentsTable.role, companyId: agentsTable.companyId })
    .from(agentsTable)
    .where(eq(agentsTable.id, ceoAgentId))
    .then((rows) => rows[0] ?? null);

  if (!ceo) {
    throw new Error(`Agent ${ceoAgentId} not found`);
  }
  if (ceo.role !== "ceo") {
    throw new Error(`Agent ${ceoAgentId} is not a CEO (role=${ceo.role})`);
  }
  if (ceo.companyId !== companyId) {
    throw new Error(`Agent ${ceoAgentId} belongs to a different company`);
  }

  const existing = await db
    .select()
    .from(issuesTable)
    .where(and(eq(issuesTable.companyId, companyId), eq(issuesTable.isCeoChat, true)))
    .then((rows) => rows[0] ?? null);

  if (existing) {
    return toCeoChatIssue(existing);
  }

  const [created] = await db
    .insert(issuesTable)
    .values({
      companyId,
      title: "CEO Chat",
      description:
        "Conversation surface between the board (you) and the CEO. The CEO uses this thread to plan, ask questions, request approvals, spawn issues, and report back. This issue is excluded from the normal task lists.",
      status: "in_progress",
      priority: "low",
      assigneeAgentId: ceoAgentId,
      createdByAgentId: ceoAgentId,
      isCeoChat: true,
    })
    .returning();

  return toCeoChatIssue(created!);
}

function toCeoChatIssue(row: typeof issuesTable.$inferSelect): CeoChatIssue {
  return {
    id: row.id,
    companyId: row.companyId,
    assigneeAgentId: row.assigneeAgentId!,
    isCeoChat: row.isCeoChat,
    status: row.status,
    title: row.title,
  };
}
