import { expect } from "@playwright/test";
import { taskDocumentHistoryPasses, taskDocumentMatches, type TaskDocumentExpectation, type TaskDocumentRevision, type TaskDocumentSnapshot } from "./task-document-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

async function openDocumentAuthoring({ page }: JourneyContext) {
  const create = page.getByRole("button", { name: "New document", exact: true });
  const properties = page.getByRole("button", { name: /^(Show properties|Properties)$/ }).first();
  const artifacts = page.getByRole("tab", { name: /^Artifacts/ }).first();
  const addTab = page.getByRole("button", { name: "Open a new tab", exact: true });
  const panelReady = async () => await create.isVisible() || await artifacts.isVisible() || await addTab.isVisible();
  await expect.poll(async () => await properties.isVisible() || await panelReady()).toBe(true);
  if (await create.isVisible()) return;
  if (await properties.isVisible()) {
    await properties.click();
    await expect.poll(panelReady).toBe(true);
    if (await create.isVisible()) return;
  }
  if (await artifacts.isVisible()) await artifacts.click();
  else {
    await addTab.click();
    await page.getByRole("option", { name: /^Artifacts/ }).click();
  }
  await expect(create).toBeVisible();
}

export async function reopenTaskDocument(context: JourneyContext, issue: { title: string }) {
  const { page, api, company } = context;
  await page.goto(`${api.origin}/${company.issuePrefix}/issues?view=backlog&q=${encodeURIComponent(issue.title)}`);
  await page.getByRole("link").filter({ hasText: issue.title }).first().click();
  await page.reload();
  await openDocumentAuthoring(context);
}

export async function taskDocumentPersistence(context: JourneyContext, _session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  const { page, api, company, user } = context;
  const issue = context.fixtures?.backlogTask;
  if (!issue?.id || !issue.identifier) throw new JourneyError("blocked", "missing_prepared_backlog_task");
  const route = `/api/issues/${issue.id}`;
  const key = "qa-note";
  const documentRoute = `${route}/documents/${key}`;
  const original: TaskDocumentExpectation = { companyId: company.id, issueId: issue.id, userId: user.id, key,
    title: `QA document ${campaignId}`, body: `Original task note for ${campaignId}.` };
  const revised = { ...original, title: `${original.title} revised`, body: `Persisted document ${campaignId}: revised text survives a reload.` };
  if ((await api.get<TaskDocumentSnapshot[]>(`${route}/documents`)).some(document => document.key === key)) {
    throw new JourneyError("failed", "task_document_fixture_not_fresh");
  }

  await page.goto(`${api.origin}/${company.issuePrefix}/issues/${issue.identifier}`);
  await openDocumentAuthoring(context);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  const form = page.getByPlaceholder("Document key", { exact: true }).locator("..");
  await page.getByPlaceholder("Document key", { exact: true }).fill(key);
  await page.getByPlaceholder("Optional title", { exact: true }).fill(original.title);
  const newEditor = form.locator('[contenteditable="true"], textarea').first();
  await newEditor.fill(original.body);
  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await expect.poll(async () => taskDocumentMatches((await api.get<TaskDocumentSnapshot[]>(`${route}/documents`)).find(document => document.key === key), original),
    { timeout: 30_000, intervals: [300, 600, 1000] }).toBe(true);
  const initial = await api.get<TaskDocumentSnapshot>(documentRoute);
  if (!taskDocumentMatches(initial, original)) throw new JourneyError("failed", "created_document_mismatch");
  evidence.checks.push({ id: "browser-document-created", passed: true });

  // Reopen the persisted document before editing; a locally retained draft cannot stand in for the saved body.
  await page.reload();
  await openDocumentAuthoring(context);
  const document = page.locator(`#document-${key}`);
  await expect(document.getByText(original.body, { exact: true })).toBeVisible();
  await document.getByRole("button", { name: "Document actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit document", exact: true }).click();
  const editor = document.locator('[contenteditable="true"], textarea').first();
  if (await editor.getAttribute("contenteditable") === "true") await expect(editor).toHaveText(original.body);
  else await expect(editor).toHaveValue(original.body);
  await document.getByPlaceholder("Optional title", { exact: true }).fill(revised.title);
  await editor.fill(revised.body);
  // Leaving the editor uses the production blur/autosave contract.
  await page.getByRole("button", { name: "New document", exact: true }).focus();
  await expect.poll(async () => taskDocumentMatches(await api.get<TaskDocumentSnapshot>(documentRoute), revised),
    { timeout: 30_000, intervals: [300, 600, 1000] }).toBe(true);
  const current = await api.get<TaskDocumentSnapshot>(documentRoute);
  const revisions = await api.get<TaskDocumentRevision[]>(`${documentRoute}/revisions`);
  const originalRevision = await api.get<TaskDocumentRevision>(`${documentRoute}/revisions/${initial.latestRevisionId}`);
  const currentRevision = await api.get<TaskDocumentRevision>(`${documentRoute}/revisions/${current.latestRevisionId}`);
  if (!taskDocumentHistoryPasses({ initial, current, original, revised, revisions, originalRevision, currentRevision })) {
    throw new JourneyError("failed", "task_document_revision_history_mismatch");
  }
  evidence.checks.push({ id: "document-revision-history-preserved", passed: true });

  await reopenTaskDocument(context, issue);
  await expect(document.getByText(revised.title, { exact: true })).toBeVisible();
  await expect(document.getByText(revised.body, { exact: true })).toBeVisible();
  const reopened = await api.get<TaskDocumentSnapshot>(documentRoute);
  const savedIssue = await api.get<{ companyId: string; status: string }>(route);
  if (!taskDocumentMatches(reopened, revised) || reopened.latestRevisionId !== current.latestRevisionId
    || reopened.latestRevisionNumber !== current.latestRevisionNumber) throw new JourneyError("failed", "task_document_reload_mismatch");
  if (savedIssue.companyId !== company.id || savedIssue.status !== "backlog" || (await api.get<unknown[]>(`${route}/runs`)).length) {
    throw new JourneyError("failed", "browser_only_journey_started_agent_work");
  }
  evidence.checks.push({ id: "document-reopened-after-reload", passed: true }, { id: "no-agent-work", passed: true });
}
