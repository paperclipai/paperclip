import { expect, type Locator, type Page } from "@playwright/test";
import { taskSearchEvidencePasses, type SearchTask } from "./task-search-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type TaskSearchStage = "prepare" | "open_collection" | "clear_filters" | "search_results" | "apply_status"
  | "persist_view" | "reload_collection" | "open_result" | "reload_result" | "return_collection"
  | "reopen_result" | "verify_saved";

/** The legacy glyph contributes a second Backlog to the checkbox's name. */
export function taskSearchBacklogCheckbox(filters: Locator) {
  return filters.getByText("Status", { exact: true }).locator("..")
    .getByRole("checkbox", { name: /^Backlog(?:\s*Backlog)?$/ });
}

async function resultIds(page: Page, tasks: readonly SearchTask[]) {
  const ids: string[] = [];
  for (const link of await page.locator("main#main-content a[data-inbox-issue-link]").all()) {
    if (!await link.isVisible()) continue;
    const href = await link.getAttribute("href");
    const identifier = href ? decodeURIComponent(new URL(href, page.url()).pathname.split("/").at(-1)!) : "";
    ids.push(tasks.find(task => task.identifier === identifier || task.id === identifier)?.id ?? `unknown:${identifier}`);
  }
  return ids.sort();
}

async function expectResults(page: Page, tasks: readonly SearchTask[], expectedIds: readonly string[]) {
  let observed: string[] = [];
  await expect.poll(async () => { observed = await resultIds(page, tasks); return observed; }, { timeout: 30_000 })
    .toEqual([...expectedIds].sort());
  return observed;
}

async function openFilters(page: Page) {
  await page.getByRole("button", { name: /^(Filter|Filters: \d+)$/ })
    .or(page.getByTitle(/^(Filter|Filters: \d+)$/)).click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(filters).toBeVisible();
  return filters;
}

async function readStatusSelection(page: Page) {
  const filters = await openFilters(page);
  const selected = await taskSearchBacklogCheckbox(filters).isChecked();
  await page.keyboard.press("Escape");
  return selected;
}

function openedIdentifier(page: Page, context: JourneyContext) {
  const url = new URL(page.url());
  const prefix = `/${context.company.issuePrefix}/issues/`;
  return url.origin === context.api.origin && url.pathname.startsWith(prefix)
    ? decodeURIComponent(url.pathname.slice(prefix.length)) : null;
}

/** API setup owns three tasks; search, filtering and opening use the shipped UI. */
export async function taskSearchFilter(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  for (const capability of ["company", "board-user", "task-write"]) {
    if (!context.capabilities.includes(capability)) throw new JourneyError("unsupported", `missing_${capability}`);
  }
  if (!campaignId) throw new JourneyError("blocked", "task_search_campaign_required");
  const { api, page, company, user } = context;
  let stage: TaskSearchStage = "prepare";
  try {
    const marker = `needle-${campaignId}`;
    const tasks: SearchTask[] = [];
    for (const fixture of [
      { title: `Journey QA ${marker} target`, status: "backlog", description: `Search target context ${campaignId}. Keep this for board review.` },
      { title: `Journey QA ${marker} status control`, status: "done", description: `Completed control context ${campaignId}.` },
      { title: `Journey QA unrelated ${campaignId}`, status: "backlog", description: `Different search control context ${campaignId}.` },
    ]) {
      const ownership = { kind: "issue" as const, name: fixture.title, journeyId: "task-search-filter" as const };
      await session.own(ownership);
      const created = await api.post<{ id: string; identifier: string }>(`/api/companies/${company.id}/issues`, {
        ...fixture, assigneeUserId: user.id, assigneeAgentId: null,
      });
      if (created.id) await session.own({ ...ownership, id: created.id });
      if (!created.id || !created.identifier) throw new JourneyError("failed", "task_search_fixture_receipt_missing");
      tasks.push({ ...fixture, id: created.id, identifier: created.identifier, companyId: company.id,
        assigneeUserId: user.id, assigneeAgentId: null });
    }
    const [target, statusControl] = tasks as [SearchTask, SearchTask, SearchTask];
    stage = "open_collection";
    await page.goto(`${api.origin}/${company.issuePrefix}/issues`);
    await expect(page.locator("main#main-content")).toBeVisible();
    const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
    // Select the task collection through its normal view control when present.
    const views = page.getByRole("button", { name: /^(Change view — currently |Task view: )/ }).first();
    await expect(views.or(search).first()).toBeVisible();
    if (await views.isVisible()) {
      await views.click();
      await page.getByRole("menuitem", { name: /^All tasks/ }).or(page.getByRole("menuitemradio", { name: "All tasks", exact: true })).click();
    }
    await expect(search).toBeVisible();
    const listView = page.getByRole("button", { name: "List view", exact: true });
    if (await listView.isVisible()) await listView.click();
    stage = "clear_filters";
    const filters = await openFilters(page);
    const clear = filters.getByRole("button", { name: "Clear", exact: true });
    if (await clear.isVisible()) await clear.click();
    await page.keyboard.press("Escape");
    stage = "search_results";
    await search.fill(marker);
    const searchIds = await expectResults(page, tasks, [target.id, statusControl.id]);
    stage = "apply_status";
    const statusFilters = await openFilters(page);
    await taskSearchBacklogCheckbox(statusFilters).check();
    await page.keyboard.press("Escape");
    const filteredIds = await expectResults(page, tasks, [target.id]);

    // The combined Tasks shell defines status through its named view on mount.
    // Its Backlog view preserves the chosen status across reload/Back navigation.
    stage = "persist_view";
    const namedView = page.getByRole("button", { name: /^Change view — currently / }).first();
    if (await namedView.isVisible()) {
      await namedView.click();
      await page.getByRole("menuitem", { name: /^Backlog/ }).click();
      await expect(search).toHaveValue("");
      await search.fill(marker);
      await expectResults(page, tasks, [target.id]);
    }

    stage = "reload_collection";
    await page.reload();
    await expect(search).toHaveValue(marker);
    const reloadedStatusSelected = await readStatusSelection(page);
    const reloadedIds = await expectResults(page, tasks, [target.id]);
    const reloadedQuery = await search.inputValue();
    const targetLink = () => page.locator("main#main-content a[data-inbox-issue-link]")
      .filter({ hasText: target.title });
    stage = "open_result";
    await targetLink().click();
    await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
    const firstOpened = openedIdentifier(page, context);
    stage = "reload_result";
    await page.reload();
    await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
    await expect(page.getByText(target.description, { exact: true })).toBeVisible();

    stage = "return_collection";
    await page.goBack();
    await expect(search).toHaveValue(marker);
    const returnedStatusSelected = await readStatusSelection(page);
    const returnedIds = await expectResults(page, tasks, [target.id]);
    const returnedQuery = await search.inputValue();
    stage = "reopen_result";
    await targetLink().click();
    await page.reload();
    await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
    await expect(page.getByText(target.description, { exact: true })).toBeVisible();
    stage = "verify_saved";
    const saved: SearchTask[] = [];
    const runs: unknown[][] = [];
    for (const task of tasks) {
      saved.push(await api.get<SearchTask>(`/api/issues/${task.id}`));
      runs.push(await api.get<unknown[]>(`/api/issues/${task.id}/runs`));
    }
    const checks = taskSearchEvidencePasses({ expected: tasks, saved, runs, marker, searchIds, filteredIds,
      reloadedIds, returnedIds, reloadedQuery, returnedQuery, reloadedStatusSelected, returnedStatusSelected,
      openedIdentifier: firstOpened, reopenedIdentifier: openedIdentifier(page, context),
      titleVisible: await page.getByRole("heading", { name: target.title, exact: true }).isVisible(),
      descriptionVisible: await page.getByText(target.description, { exact: true }).isVisible() });
    const entries = [
      { id: "task-search-results-exact", passed: checks.search },
      { id: "task-status-filter-excludes-controls", passed: checks.filter },
      { id: "task-search-filter-reloaded", passed: checks.persistence },
      { id: "task-search-result-reopened", passed: checks.reopen },
      { id: "no-agent-work", passed: checks.noAgentWork },
    ];
    evidence.checks.push(...entries);
    if (entries.some(check => !check.passed)) throw new JourneyError("failed", "task_search_evidence_mismatch");
  } catch (error) {
    if (error instanceof JourneyError) throw error;
    // Only a closed stage identifier survives; browser errors can contain
    // private URLs, form values, or response data.
    throw new JourneyError("failed", `task_search_${stage}_failed`);
  }
}
