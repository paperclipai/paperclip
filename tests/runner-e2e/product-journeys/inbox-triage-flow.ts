import { expect } from "@playwright/test";
import { inboxArchivePersisted, inboxTaskMatches, inboxTaskResurfaced, type InboxTaskEvidence } from "./inbox-triage-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

export async function inboxTriage(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  const { api, page, company, user } = context;
  const title = `Journey QA inbox triage ${campaignId}`;
  await session.own({ kind: "issue", name: title, journeyId: "inbox-triage" });
  const issue = await api.post<InboxTaskEvidence & { title: string; identifier: string }>(`/api/companies/${company.id}/issues`, {
    title, description: "Disposable personal inbox triage task.", assigneeUserId: user.id, assigneeAgentId: null, status: "in_progress",
  });
  await session.own({ kind: "issue", name: title, id: issue.id, journeyId: "inbox-triage" });
  const route = `/api/issues/${issue.id}`, expected = { id: issue.id, companyId: company.id, userId: user.id, status: "in_progress" };
  const check = (id: string, passed: boolean) => {
    evidence.checks.push({ id, passed });
    if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
  };
  const read = () => api.get<InboxTaskEvidence>(route);
  const mine = () => api.get<InboxTaskEvidence[]>(`/api/companies/${company.id}/issues?touchedByUserId=me&inboxArchivedByUserId=me`);
  const open = async (view: "mine" | "unread") => {
    await page.goto(`${api.origin}/${company.issuePrefix}/inbox/${view}`, { waitUntil: "domcontentloaded" });
    const search = page.getByPlaceholder(/^Search (?:inbox|tasks)(?:…|\.\.\.)$/i);
    await expect(search).toBeVisible();
    await search.fill(title);
  };
  const row = page.locator(`[data-issue-row-details="${issue.id}"]`).first();
  // Establish the unread starting state through the ordinary Mark unread API.
  await api.delete(`${route}/read`);
  await expect.poll(async () => (await read()).isUnreadForMe).toBe(true);
  await open("unread");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Mark as read", exact: true }).click();
  await expect.poll(async () => (await read()).isUnreadForMe).toBe(false);
  await page.reload();
  await open("unread");
  await expect(row).toHaveCount(0);
  check("inbox-read-persisted", inboxTaskMatches(await read(), expected) && (await read()).isUnreadForMe === false);

  await open("mine");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Archive", exact: true }).click();
  await expect.poll(async () => inboxArchivePersisted(await read(), expected, await mine())).toBe(true);
  await page.reload();
  await open("mine");
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No inbox items match these filters.", { exact: true })).toBeVisible();
  check("inbox-archive-persisted", inboxArchivePersisted(await read(), expected, await mine()));
  check("inbox-archive-preserved-task-status", (await read()).status === "in_progress");

  // A real new Blocked transition is relevant activity. The fixture supplies the
  // event, while the production archive policy must independently resurface it.
  await api.patch(route, { status: "blocked" });
  const blocked = { ...expected, status: "blocked" };
  await expect.poll(async () => inboxTaskResurfaced(await read(), blocked, await mine())).toBe(true);
  await open("mine");
  await expect(row).toBeVisible();
  await page.reload();
  await open("mine");
  await expect(row).toBeVisible();
  check("inbox-relevant-activity-resurfaced", inboxTaskResurfaced(await read(), blocked, await mine()));
  check("no-agent-work", (await api.get<unknown[]>(`${route}/runs`)).length === 0);
  // Leave the owned task open for the launcher's authenticated task screenshot.
  await page.goto(`${api.origin}/${company.issuePrefix}/issues/${issue.identifier}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}
