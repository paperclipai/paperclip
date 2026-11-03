import { expect } from "@playwright/test";
import { inboxArchivePersisted, inboxTaskMatches, inboxTaskResurfaced, type InboxTaskEvidence } from "./inbox-triage-evidence.js";
import { inboxAuthorCommentMatches, type InboxAuthorComment } from "./inbox-author-contract.js";
import { inboxBlockedActivity } from "./inbox-triage-fixture.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

export async function inboxStep<T>(code: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof JourneyError) throw error;
    // Browser errors may carry form values and URLs. Retain only the fixed
    // operation code, including which independent read failed.
    throw new JourneyError("failed", code);
  }
}

export async function openPersonalInbox(context: Pick<JourneyContext, "page" | "api" | "company">, view: "mine" | "unread") {
  const { page, api, company } = context;
  await inboxStep(`inbox_${view}_view_unavailable`, async () => {
    await page.goto(`${api.origin}/${company.issuePrefix}/inbox/${view}`, { waitUntil: "domcontentloaded" });
    const search = page.getByPlaceholder(/^Search (?:inbox|tasks)(?:…|\.\.\.)$/i);
    await expect(search).toBeVisible();
    // Global search supplements the inbox with other results whose read and
    // archive controls differ. Act on the real personal view, scoped by row ID.
    await search.fill("");
    await expect(search).toHaveValue("");
    // An absent row is meaningful only after this actual view has loaded its
    // list or the correct empty state; a skeleton cannot prove exclusion.
    await expect(page.getByRole("status", { name: "Loading tasks", exact: true })).toHaveCount(0);
    const empty = page.getByText(view === "mine" ? "Inbox zero." : "No new inbox items.", { exact: true });
    await expect(page.locator("#main-content [data-inbox-item]").or(empty).first()).toBeVisible();
  });
}

export async function inboxTriage(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  const { api, page, company, user } = context;
  const author = context.fixtures?.inboxAuthor;
  if (!author?.userId || author.userId === user.id) throw new JourneyError("unsupported", "inbox_human_author_required");
  const title = `Journey QA inbox triage ${campaignId}`;
  await session.own({ kind: "issue", name: title, journeyId: "inbox-triage" });
  const issue = await inboxStep("inbox_task_creation_failed", () => api.post<InboxTaskEvidence & { title: string; identifier: string }>(`/api/companies/${company.id}/issues`, {
    title, description: "Disposable personal inbox triage task.", assigneeUserId: user.id, assigneeAgentId: null, status: "in_progress",
  }));
  await session.own({ kind: "issue", name: title, id: issue.id, journeyId: "inbox-triage" });
  const route = `/api/issues/${issue.id}`, expected = { id: issue.id, companyId: company.id, userId: user.id, status: "in_progress" };
  const check = (id: string, passed: boolean) => {
    evidence.checks.push({ id, passed });
    if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
  };
  // Personal unread fields are available on the user-aware list projection.
  const read = async () => {
    const rows = await api.get<InboxTaskEvidence[]>(`/api/companies/${company.id}/issues?assigneeUserId=me&touchedByUserId=me&q=${encodeURIComponent(title)}`);
    const own = rows.find(row => row.id === issue.id);
    if (!own) throw new JourneyError("failed", "inbox_owned_task_projection_missing");
    return own;
  };
  const mine = () => api.get<InboxTaskEvidence[]>(`/api/companies/${company.id}/issues?touchedByUserId=me&inboxArchivedByUserId=me`);
  const row = page.locator(`[data-issue-row-details="${issue.id}"]`).first();
  // Agent writes correctly require a real heartbeat run. The model-free inbox
  // fixture uses a second normal human session rather than inventing a run.
  const body = `Inbox fixture update ${campaignId}`;
  const posted = await inboxStep("inbox_external_comment_failed", () => author.postComment({ issueId: issue.id, body }));
  const saved = await inboxStep("inbox_external_comment_read_failed", () => api.get<InboxAuthorComment>(`${route}/comments/${posted.id}`));
  const expectedAuthor = { companyId: company.id, issueId: issue.id, ownerUserId: user.id, authorUserId: author.userId, body };
  check("inbox-external-human-activity", posted.id === saved.id
    && inboxAuthorCommentMatches(posted, expectedAuthor) && inboxAuthorCommentMatches(saved, expectedAuthor));
  await inboxStep("inbox_mark_unread_failed", () => api.delete(`${route}/read`));
  await inboxStep("inbox_unread_projection_failed", () => expect.poll(async () => (await read()).isUnreadForMe).toBe(true));
  await openPersonalInbox(context, "unread");
  await inboxStep("inbox_unread_row_missing", () => expect(row).toBeVisible());
  await inboxStep("inbox_mark_read_failed", () => row.getByRole("button", { name: "Mark as read", exact: true }).click());
  await inboxStep("inbox_read_projection_failed", () => expect.poll(async () => (await read()).isUnreadForMe).toBe(false));
  await inboxStep("inbox_unread_reload_failed", () => page.reload());
  await openPersonalInbox(context, "unread");
  await inboxStep("inbox_read_row_still_visible", () => expect(row).toHaveCount(0));
  check("inbox-read-persisted", inboxTaskMatches(await read(), expected) && (await read()).isUnreadForMe === false);

  await openPersonalInbox(context, "mine");
  await inboxStep("inbox_mine_row_missing", () => expect(row).toBeVisible());
  await inboxStep("inbox_archive_control_failed", async () => {
    await row.hover();
    await row.getByRole("button", { name: "Archive", exact: true }).click();
  });
  await inboxStep("inbox_archive_projection_failed", () => expect.poll(async () => inboxArchivePersisted(await read(), expected, await mine())).toBe(true));
  await inboxStep("inbox_mine_reload_failed", () => page.reload());
  await openPersonalInbox(context, "mine");
  await inboxStep("inbox_archived_row_still_visible", () => expect(row).toHaveCount(0));
  check("inbox-archive-persisted", inboxArchivePersisted(await read(), expected, await mine()));
  check("inbox-archive-preserved-task-status", (await read()).status === "in_progress");

  // A real new Blocked transition is relevant activity. The fixture supplies the
  // event, while the production archive policy must independently resurface it.
  await inboxStep("inbox_relevant_activity_failed", () => api.patch(route, inboxBlockedActivity(user.id)));
  const blocked = { ...expected, status: "blocked" };
  await inboxStep("inbox_resurface_projection_failed", () => expect.poll(async () => inboxTaskResurfaced(await read(), blocked, await mine())).toBe(true));
  await openPersonalInbox(context, "mine");
  await inboxStep("inbox_resurfaced_row_missing", () => expect(row).toBeVisible());
  await inboxStep("inbox_resurfaced_reload_failed", () => page.reload());
  await openPersonalInbox(context, "mine");
  await inboxStep("inbox_resurfaced_row_lost", () => expect(row).toBeVisible());
  check("inbox-relevant-activity-resurfaced", inboxTaskResurfaced(await read(), blocked, await mine()));
  check("no-agent-work", (await api.get<unknown[]>(`${route}/runs`)).length === 0);
  // Leave the owned task open for the launcher's authenticated task screenshot.
  await inboxStep("inbox_task_reopen_failed", async () => {
    await page.goto(`${api.origin}/${company.issuePrefix}/issues/${issue.identifier}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  });
}
