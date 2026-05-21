import type { Db } from "@paperclipai/db";
import { agentService, issueService } from "../../services/index.js";
import type { EnvironmentBlockerResult } from "./detector.js";

export async function createProvisioningChildIssue(
  db: Db,
  companyId: string,
  sourceIssueId: string,
  sourceIssueIdentifier: string,
  blocker: EnvironmentBlockerResult,
  createdByAgentId: string | null,
): Promise<{ id: string; identifier: string }> {
  const agentsSvc = agentService(db);
  const svc = issueService(db);

  const agents = await agentsSvc.list(companyId);

  let assigneeAgentId: string | null = null;
  if (blocker.ownerType === "CTO") {
    const cto = agents.find(
      (a) =>
        a.name?.toUpperCase() === "CTO" ||
        (a.title ?? "").toUpperCase().includes("CTO") ||
        (a.title ?? "").toUpperCase().includes("CHIEF TECHNOLOGY"),
    );
    assigneeAgentId = cto?.id ?? null;
  } else {
    const ceo = agents.find(
      (a) =>
        a.name?.toUpperCase() === "CEO" ||
        (a.title ?? "").toUpperCase().includes("CEO") ||
        (a.title ?? "").toUpperCase().includes("CHIEF EXECUTIVE"),
    );
    assigneeAgentId = ceo?.id ?? null;
  }

  const issue = await svc.create(companyId, {
    parentId: sourceIssueId,
    title: `Provision ${blocker.resource} for ${sourceIssueIdentifier}`,
    description: `Provisioning blocker auto-detected from [${sourceIssueIdentifier}](/PAI/issues/${sourceIssueIdentifier}).\n\nEnvironment needed: **${blocker.resource}**\n\nOnce provisioned, mark this issue done to unblock the parent.`,
    status: "todo",
    priority: "high",
    assigneeAgentId,
    createdByAgentId,
  });

  return { id: issue.id, identifier: issue.identifier ?? issue.id };
}
