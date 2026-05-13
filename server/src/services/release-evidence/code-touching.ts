import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueLabels, labels, workspaceOperations } from "@paperclipai/db";
import {
  CODE_TOUCHING_LABEL,
  NOT_CODE_GATE_LABEL,
  type CodeTouchingDecision,
} from "./types.js";

const NON_CODE_ROLES = new Set(["ceo", "manager", "reviewer", "advisor"]);
const ENGINEER_ROLES = new Set([
  "engineer",
  "cto",
  "security",
  "qa",
  "designer",
  "data",
  "platform",
]);

export type CodeTouchingContext = {
  issueId: string;
  companyId: string;
  parentId: string | null;
  executionWorkspaceId: string | null;
  assigneeAgentId: string | null;
};

export async function detectCodeTouching(
  db: Db,
  ctx: CodeTouchingContext,
): Promise<CodeTouchingDecision> {
  const labelNames = await loadIssueLabels(db, ctx.issueId);

  if (labelNames.includes(NOT_CODE_GATE_LABEL)) {
    return { codeTouching: false, reason: "label_not_code_gate_override" };
  }
  if (labelNames.includes(CODE_TOUCHING_LABEL)) {
    return { codeTouching: true, reason: "label_code_touching" };
  }

  if (await hasWorkspaceDiff(db, ctx.executionWorkspaceId)) {
    return { codeTouching: true, reason: "workspace_diff_present" };
  }

  const assigneeRole = await loadAssigneeRole(db, ctx.assigneeAgentId);
  if (assigneeRole && NON_CODE_ROLES.has(assigneeRole)) {
    return { codeTouching: false, reason: "non_engineer_role_default_not_code" };
  }
  if (assigneeRole && ENGINEER_ROLES.has(assigneeRole)) {
    return { codeTouching: true, reason: "engineer_role_default_code_touching" };
  }

  if (ctx.parentId && (await parentIsCodeTouching(db, ctx.parentId))) {
    return { codeTouching: true, reason: "parent_inherits_code_touching" };
  }

  return { codeTouching: false, reason: "default_not_code" };
}

async function loadIssueLabels(db: Db, issueId: string): Promise<string[]> {
  const rows = await db
    .select({ name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, issueId));
  return rows.map((row) => row.name);
}

async function hasWorkspaceDiff(db: Db, executionWorkspaceId: string | null): Promise<boolean> {
  if (!executionWorkspaceId) return false;
  const rows = await db
    .select({ id: workspaceOperations.id })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId),
        inArray(workspaceOperations.phase, ["diff", "commit", "merge", "push", "git_diff"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function loadAssigneeRole(db: Db, assigneeAgentId: string | null): Promise<string | null> {
  if (!assigneeAgentId) return null;
  const rows = await db
    .select({ role: agents.role })
    .from(agents)
    .where(eq(agents.id, assigneeAgentId))
    .limit(1);
  return rows[0]?.role?.toLowerCase() ?? null;
}

async function parentIsCodeTouching(db: Db, parentId: string): Promise<boolean> {
  const labelRows = await loadIssueLabels(db, parentId);
  if (labelRows.includes(NOT_CODE_GATE_LABEL)) return false;
  if (labelRows.includes(CODE_TOUCHING_LABEL)) return true;
  return false;
}
