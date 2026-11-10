import { expect } from "@playwright/test";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { fixtureWorker, makeDefinition } from "./internal-definition.js";
import { openStandingChat } from "./identity-support.js";
import { agentStatus, cleanupPrivacyProbes, mainPerson, observerPerson, personRead } from "./internal-privacy.js";
import { checks, entity, hasLink, observation, observeInternal, project, putDocument, type Entity, type InternalObservation } from "./internal-support.js";

interface PrivateTask extends Entity { visibility?: string; privacyRootIssueId?: string | null; conversationAgentId?: string | null }
interface PrivateDelegationObservation extends InternalObservation {
  sourcePrivate: boolean; projectPrivate: boolean; leadProjectStatus: number; workerProjectStatus: number; workerTaskStatus?: number;
  observerCompanyStatus: number; observerTaskStatus?: number; observerSourceStatus: number; observerProjectsStatus: number;
  observerProjectsBody: string; observerSearchStatus: number; observerSearchResults: string;
}
export function gradePrivateDelegation(value: unknown) {
  const c = checks(); const o = observation(value) as PrivateDelegationObservation | undefined;
  c.add("actual-private-delegation-evidence", !!o && typeof o.sourcePrivate === "boolean" && typeof o.observerCompanyStatus === "number",
    "Saved source/project privacy and independently authenticated reader/search evidence are required.");
  if (!o || typeof o.sourcePrivate !== "boolean") return c.result();
  const p = entity(o.state, "project"); const worker = entity(o.state, "worker"); const saved = o.tasks[0];
  c.add("source-and-project-boundary", o.sourcePrivate && o.projectPrivate && o.leadProjectStatus === 200 && o.workerProjectStatus === 200,
    "The private conversation and existing private project remain restricted while both authorized agents retain actual access.");
  c.add("one-authorized-confidential-task", o.tasks.length === 1 && !!saved && saved.companyId === o.companyId && saved.projectId === p.id
    && saved.assigneeAgentId === worker.id && !(saved as PrivateTask).conversationAgentId
    && /\b(?:announcements?|announce|launch\s+(?:message|copy|notice|post))\b/i.test(`${saved.title} ${saved.description ?? ""}`)
    && o.activity.some(row => row.action === "issue.created" && row.entityId === saved.id && row.agentId === o.leadId)
    && hasLink(o, "issues", saved), "Exactly one ordinary confidential launch task belongs to the actual private project and authorized Morgan, with an inspectable source link.");
  c.add("morgan-retains-effective-access", o.workerTaskStatus === 200, "The actual assignee's independent bearer can retrieve the private delegated task.");
  c.add("unrelated-human-cannot-discover-or-read", o.observerCompanyStatus === 200 && o.observerProjectsStatus === 200 && o.observerSearchStatus === 200
    && [403, 404].includes(o.observerTaskStatus ?? 0) && [403, 404].includes(o.observerSourceStatus)
    && !!saved && !o.observerProjectsBody.includes(p.id) && !o.observerSearchResults.includes(saved.id)
    && !o.observerSearchResults.includes(String(o.state.confidentialMarker)),
    "A healthy unrelated company member cannot discover protected project/task contents or open the copied work/source IDs.");
  const workRuns = saved ? o.runs.filter(row => row.contextSnapshot?.issueId === saved.id || row.contextSnapshot?.taskId === saved.id) : [];
  c.add("real-private-worker-admission", workRuns.length === 1 && workRuns[0]?.agentId === worker.id && ["queued", "running", "succeeded"].includes(workRuns[0]?.status ?? ""),
    "Actual worker execution belongs to the private work task instead of the standing conversation.");
  return c.result();
}
function privateDelegation(): ChatCatalogCase {
  let observer: Awaited<ReturnType<typeof observerPerson>> | undefined;
  const base = makeDefinition("tasks.private-task", async ctx => {
    const ownerId = await mainPerson(ctx); observer = await observerPerson(ctx); const worker = await fixtureWorker(ctx);
    const confidentialMarker = `Confidential launch code NIGHTJAR-${ctx.input.nonce}`;
    const p = await project(ctx, "Private Launch", { visibility: "private", description: `${confidentialMarker}. Acorn Notes launches next month for small research teams; draft a short confidential announcement for internal review.` });
    for (const agentId of [ctx.input.fixtures.agent.id, worker.id])
      await ctx.input.api.post(`/api/projects/${p.id}/access-members`, { subjectType: "agent", subjectId: agentId });
    const source = await openStandingChat(ctx);
    const current = await ctx.input.api.get<PrivateTask>(`/api/issues/${source.id}`);
    if (current.visibility !== "private") await ctx.input.api.patch(`/api/issues/${source.id}`, { visibility: "private" });
    await putDocument(ctx, source.id, `# Confidential launch brief\n${confidentialMarker}. Keep the announcement inside Private Launch and its authorized team.\n`);
    return { project: p, worker, ownerId, observerId: observer.id, sourceId: source.id, confidentialMarker };
  }, gradePrivateDelegation);
  return { ...base, authentication: "human-session", expectedRunCount: 3, minimumRunCount: 2,
    runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 },
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-private-delegation.ts", "chat-catalog-domains/internal-privacy.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-support.ts"],
    async observe(ctx, state): Promise<PrivateDelegationObservation> {
      if (!observer) throw new Error("Missing authenticated unrelated member");
      const o = await observeInternal(ctx, state); const saved = o.tasks[0]; const p = entity(state, "project"); const worker = entity(state, "worker");
      const [source, projectNow, leadProjectStatus, workerProjectStatus, workerTaskStatus, companyRead, taskRead, sourceRead, projectsRead, searchRead] = await Promise.all([
        ctx.input.api.get<PrivateTask>(`/api/issues/${state.sourceId}`), ctx.input.api.get<PrivateTask>(`/api/projects/${p.id}`),
        agentStatus(ctx, o.leadId, `/api/projects/${p.id}`), agentStatus(ctx, worker.id, `/api/projects/${p.id}`),
        saved ? agentStatus(ctx, worker.id, `/api/issues/${saved.id}`) : undefined,
        personRead(observer, `/api/companies/${o.companyId}`), saved ? personRead(observer, `/api/issues/${saved.id}`) : undefined,
        personRead(observer, `/api/issues/${state.sourceId}`), personRead(observer, `/api/companies/${o.companyId}/projects`),
        personRead(observer, `/api/companies/${o.companyId}/search?q=${encodeURIComponent(saved?.identifier ?? saved?.title ?? String(state.confidentialMarker))}`),
      ]);
      const search = searchRead.status === 200 ? JSON.parse(searchRead.body) as { results?: unknown[] } : {};
      if (searchRead.status === 200 && !Array.isArray(search.results)) throw new Error("Private-task search did not return the production result collection");
      return { ...o, sourcePrivate: source.visibility === "private", projectPrivate: projectNow.visibility === "private", leadProjectStatus, workerProjectStatus, workerTaskStatus,
        observerCompanyStatus: companyRead.status, observerTaskStatus: taskRead?.status, observerSourceStatus: sourceRead.status,
        observerProjectsStatus: projectsRead.status, observerProjectsBody: projectsRead.body, observerSearchStatus: searchRead.status,
        observerSearchResults: JSON.stringify(search.results ?? []) };
    },
    async verifyResult(ctx, state, value) {
      await base.verifyResult(ctx, state, value);
      if (!observer) throw new Error("Missing authenticated observer browser"); const o = value as PrivateDelegationObservation; const saved = o.tasks[0]!;
      const page = await observer.context.newPage();
      try {
        await page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/issues/${saved.identifier ?? saved.id}`, o.origin).href, { waitUntil: "domcontentloaded" });
        await expect(page.getByText(/not found|access denied|forbidden|unable to load|could not load/i).first()).toBeVisible();
        await expect(page.getByRole("heading", { name: saved.title!, exact: true })).toHaveCount(0);
        await ctx.input.evidence("chat-catalog-private-delegation-denied-observer.json", { taskId: saved.id, observerId: observer.id, denied: true });
      } finally { await page.close(); }
    },
    async cleanup(ctx) { try { await cleanupPrivacyProbes(ctx); } finally { await observer?.dispose(); observer = undefined; } },
  };
}
export const privateDelegationCases: readonly ChatCatalogCase[] = [privateDelegation()];
