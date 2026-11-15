import { expect } from "@playwright/test";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

export async function taskProperties(context: JourneyContext, _session: TargetSession, _campaignId: string, evidence: JourneyEvidence) {
  for (const capability of ["company", "board-user", "task-write"]) {
    if (!context.capabilities.includes(capability)) throw new JourneyError("unsupported", `missing_${capability}`);
  }
  const { api, page, company, user } = context;
  const issue = context.fixtures?.backlogTask;
  if (!issue?.id || !issue.title || !issue.identifier) throw new JourneyError("blocked", "missing_prepared_backlog_task");
  // The declared starting point is the task list. Navigation to the task is a user action.
  await page.goto(`${api.origin}/${company.issuePrefix}/issues`);
  await page.getByRole("link").filter({ hasText: issue.title }).first().click();
  // The task opens with its side panel either showing properties or closed.
  // Wait for one of those states to render before deciding to open it.
  const properties = page.getByRole("button", { name: /^(Show properties|Properties)$/ }).filter({ visible: true }).first();
  // Closed panes keep their rows mounted; only a visible, interactive row counts.
  const assignee = page.locator('[data-property-row]:not([inert] *):not([aria-hidden="true"] *)')
    .filter({ has: page.locator('[data-property-label="Assignee"]') }).filter({ visible: true });
  const showAssignee = async () => {
    await expect.poll(async () => await assignee.isVisible() || await properties.isVisible()).toBe(true);
    if (!await assignee.isVisible()) await properties.click();
    await expect(assignee).toBeVisible();
  };
  await showAssignee();
  await assignee.locator("[data-property-value]").getByRole("button").first().click();
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await expect.poll(async () => (await api.get<{ assigneeUserId: string }>(`/api/issues/${issue.id}`)).assigneeUserId).toBe(user.id);
  await page.reload();
  await showAssignee();
  await expect(assignee.locator("[data-property-value]")).toContainText("You");
  const persisted = await api.get<{ assigneeUserId: string; assigneeAgentId: string | null; status: string }>(`/api/issues/${issue.id}`);
  if (persisted.assigneeUserId !== user.id || persisted.assigneeAgentId !== null || persisted.status !== "backlog") throw new JourneyError("failed", "assignment_persistence_mismatch");
  const runs = await api.get<unknown[]>(`/api/issues/${issue.id}/runs`);
  if (runs.length) throw new JourneyError("failed", "browser_only_journey_started_agent_work");
  evidence.checks.push({ id: "assignment-persisted", passed: true }, { id: "no-agent-work", passed: true });
}
