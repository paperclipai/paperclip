import { expect } from "@playwright/test";
import { isolationAgentRunIds, isolationAgentRunSnapshot, isolationEntryMatches, isolationTaskMatches, restrictedCreateAllowed, restrictedForeignDenied, restrictedPositiveControl, workspacePairMatches, type CreatedIsolationTask, type IsolationTask, type IsolationWorkspace } from "./company-access-contract.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

/** Real Cloud workspace switching plus a company-scoped agent credential boundary. */
export async function companyAccessIsolation(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  const fixture = context.fixtures?.companyAccess;
  if (!fixture || !workspacePairMatches(fixture.primary, fixture.secondary) || fixture.primary.companyId !== context.company.id
    || fixture.primary.origin !== context.api.origin || fixture.restrictedActors.primary.kind !== "agent"
    || fixture.restrictedActors.primary.companyId !== context.company.id || !fixture.restrictedActors.primary.id
    || fixture.restrictedActors.secondary.kind !== "agent" || fixture.restrictedActors.secondary.companyId !== fixture.secondary.companyId
    || !fixture.restrictedActors.secondary.id) throw new JourneyError("unsupported", "company_access_fixture_required");
  const { page, api, company } = context;
  const primaryHistory = async () => {
    const ids = isolationAgentRunIds(await api.get<unknown[]>(`/api/companies/${company.id}/heartbeat-runs?agentId=${fixture.restrictedActors.primary.id}&limit=100`), fixture.restrictedActors.primary);
    if (!ids) return null;
    const details = await Promise.all(ids.map(id => api.get<unknown>(`/api/heartbeat-runs/${encodeURIComponent(id)}`)));
    const detailIds = isolationAgentRunIds(details, fixture.restrictedActors.primary);
    if (!detailIds || ids.length !== detailIds.length || ids.some((id, index) => id !== detailIds[index])) return null;
    return isolationAgentRunSnapshot(details, fixture.restrictedActors.primary);
  };
  const primaryBefore = await primaryHistory();
  if (!primaryBefore) throw new JourneyError("blocked", "isolation_primary_run_baseline_unproven");
  const homeTitle = `Journey QA isolation primary ${campaignId}`, foreignTitle = `Journey QA isolation secondary ${campaignId}`;
  const original = `Owned isolation sentinel ${campaignId}`;
  // These tasks have no assignee, so neither setup nor the write control starts agent work.
  await session.own({ kind: "issue", name: homeTitle });
  const home = await api.post<IsolationTask>(`/api/companies/${company.id}/issues`, { title: homeTitle, description: original, status: "backlog" });
  await session.own({ kind: "issue", name: homeTitle, id: home.id });
  const foreign = await fixture.createSecondaryTask(foreignTitle, original);
  const check = (id: string, passed: boolean) => {
    evidence.checks.push({ id, passed });
    if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
  };
  const readHome = () => api.get<IsolationTask>(`/api/issues/${home.id}`);
  const readForeign = () => fixture.secondaryApi.get<IsolationTask>(`/api/issues/${foreign.id}`);
  const homeExpected = { id: home.id, companyId: company.id, title: homeTitle, description: original };
  const foreignExpected = { id: foreign.id, companyId: fixture.secondary.companyId, title: foreignTitle, description: original };
  check("isolation-owner-resource-controls", isolationTaskMatches(await readHome(), homeExpected) && isolationTaskMatches(await readForeign(), foreignExpected));

  const switchTo = async (from: IsolationWorkspace, to: IsolationWorkspace, task: IsolationTask) => {
    const switcher = page.getByRole("button", { name: `Open ${from.displayName} organization switcher`, exact: true });
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    await switcher.click();
    const entries = async () => {
      const matches = [];
      for (const item of await page.locator('a[role="menuitem"]').all()) {
        if (await item.isVisible() && isolationEntryMatches(await item.getAttribute("href"), fixture.portalOrigin, to)) matches.push(item);
      }
      return matches;
    };
    await expect.poll(async () => (await entries()).length, { timeout: 30_000 }).toBe(1);
    const matches = await entries();
    if (matches.length !== 1) throw new JourneyError("failed", "isolation_workspace_entry_unverified");
    await expect(matches[0]!).toContainText(to.displayName);
    await matches[0]!.click();
    await page.waitForURL(url => url.origin === to.origin && !url.pathname.startsWith("/cloud/"));
    await page.goto(`${to.origin}/${to.issuePrefix}/issues/${task.identifier}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
  };
  await switchTo(fixture.primary, fixture.secondary, foreign);
  const secondaryCompanies = await fixture.secondaryApi.get<Array<{ id: string }>>("/api/companies");
  await switchTo(fixture.secondary, fixture.primary, home);
  const primaryCompanies = await api.get<Array<{ id: string }>>("/api/companies");
  check("cloud-workspace-switch-and-return", new URL(page.url()).origin === api.origin);
  check("workspace-data-scoped", primaryCompanies.length === 1 && primaryCompanies[0]?.id === company.id
    && secondaryCompanies.length === 1 && secondaryCompanies[0]?.id === fixture.secondary.companyId
    && isolationTaskMatches(await readHome(), homeExpected) && isolationTaskMatches(await readForeign(), foreignExpected));

  const list = async (scope: "primary" | "secondary", title: string) => {
    const selected = scope === "primary" ? api : fixture.secondaryApi;
    const companyId = scope === "primary" ? company.id : fixture.secondary.companyId;
    const rows = await selected.get<IsolationTask[]>(`/api/companies/${companyId}/issues?q=${encodeURIComponent(title)}&limit=100&offset=0&includeAgentCreatedTasks=true`);
    if (!Array.isArray(rows) || rows.length >= 100) throw new JourneyError("failed", "isolation_task_listing_unproven");
    return rows.filter(row => row.title === title);
  };
  const created: CreatedIsolationTask[] = [];
  const positive = async (scope: "primary" | "secondary", task: IsolationTask) => {
    const expected = scope === "primary" ? homeExpected : foreignExpected;
    const read = await fixture.restrictedRequest(scope, scope, "GET", task.id);
    const title = `Journey QA isolation ${scope} creation ${campaignId}`;
    const description = `QA isolation owned create ${scope} ${campaignId}`;
    const before = await list(scope, title);
    const response = await fixture.restrictedCreate(scope, scope, title, description);
    const after = await list(scope, title);
    const selected = scope === "primary" ? api : fixture.secondaryApi;
    const canonical = response.status === 201 && response.task?.id
      ? await selected.get<CreatedIsolationTask>(`/api/issues/${response.task.id}`) : null;
    if (canonical) created.push(canonical);
    return restrictedPositiveControl(read, expected) && restrictedCreateAllowed({ response, before, after, canonical,
      expected: { companyId: expected.companyId, title, description, agentId: fixture.restrictedActors[scope].id } });
  };
  check("restricted-agent-positive-controls", await positive("primary", home) && await positive("secondary", foreign));
  const deny = async (actor: "primary" | "secondary", scope: "primary" | "secondary", task: IsolationTask) => {
    const selected = scope === "primary" ? api : fixture.secondaryApi;
    const before = await selected.get<IsolationTask>(`/api/issues/${task.id}`);
    // This attempted input differs from all protected foreign sentinel content.
    const title = `Journey QA isolation ${scope} denied ${campaignId}`;
    const description = `QA isolation denied create ${scope} ${campaignId}`;
    const beforeCreates = await list(scope, title);
    const deniedRead = await fixture.restrictedRequest(actor, scope, "GET", task.id);
    const deniedWrite = await fixture.restrictedCreate(actor, scope, title, description);
    const afterCreates = await list(scope, title);
    return beforeCreates.length === 0 && afterCreates.length === 0
      && restrictedForeignDenied(deniedRead, deniedWrite, before, await selected.get<IsolationTask>(`/api/issues/${task.id}`));
  };
  check("cross-workspace-agent-read-write-denied", await deny("primary", "secondary", foreign) && await deny("secondary", "primary", home));
  const revoked = await fixture.revokeCredentials();
  check("isolation-credential-revoked", revoked.revoked && revoked.deniedStatuses.primary === 401 && revoked.deniedStatuses.secondary === 401);
  const createdRuns = await Promise.all(created.map(task => (task.companyId === company.id ? api : fixture.secondaryApi).get<unknown[]>(`/api/issues/${task.id}/runs`)));
  const primaryAfter = await primaryHistory();
  const primaryUnchanged = primaryAfter !== null && primaryBefore.length === primaryAfter.length && primaryBefore.every((id, index) => id === primaryAfter[index]);
  check("no-agent-work", primaryUnchanged && createdRuns.every(runs => runs.length === 0) && (await api.get<unknown[]>(`/api/issues/${home.id}/runs`)).length === 0
    && (await fixture.secondaryApi.get<unknown[]>(`/api/issues/${foreign.id}/runs`)).length === 0
    && (await fixture.secondaryApi.get<unknown[]>(`/api/companies/${fixture.secondary.companyId}/heartbeat-runs?agentId=${fixture.restrictedActors.secondary.id}&limit=100`)).length === 0);
  await page.reload();
  await expect(page.getByRole("heading", { name: homeTitle, exact: true })).toBeVisible();
}
