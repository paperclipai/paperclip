import type { CatalogTeam, CatalogTeamImportPreviewResult } from "../../../packages/shared/src/types/teams-catalog.js";
import { definition, externalObservation, observeExternal, root, sameRows, checks, verifyRenderedReply } from "./external-support.js";
import { collectRunEvents } from "../run-observations.js";

const LIST_TEAMS = new Set(["GET /api/teams/catalog", "GET /api/teams/catalog/{catalogId}"]);
const PREVIEW_TEAM = "POST /api/companies/{companyId}/teams/catalog/{catalogId}/preview";
const INSTALL_TEAM = "POST /api/companies/{companyId}/teams/catalog/{catalogId}/install";
/** Successful call_api operations the agent's own runs executed, from their recorded tool results. */
export function teamApiOperations(events: readonly { payload?: Record<string, unknown> | null }[]) {
  const operations: string[] = [];
  for (const event of events) {
    const prp = event.payload?.prpEvent as { payload?: { item?: { type?: string; result?: { ok?: unknown; apiOperationId?: unknown } } } } | undefined;
    const item = prp?.payload?.item;
    if (item?.type === "tool_result" && item.result?.ok === true && typeof item.result.apiOperationId === "string") operations.push(item.result.apiOperationId);
  }
  return operations;
}
/** Identity check only: the catalog's own name, slug, key or id, ignoring Markdown emphasis and case. */
export function namesCatalogTeam(reply: string, team: Pick<CatalogTeam, "name" | "slug" | "key" | "id">) {
  const text = reply.replace(/[*_`]/g, "").toLowerCase();
  return [team.name, team.slug, team.slug.replaceAll("-", " "), team.key, team.id].some(name => !!name && text.includes(name.toLowerCase()));
}
/** Identity check only: each required skill is named by a literal the catalog returned for it (ref, id or key). */
export function namesRequiredSkills(reply: string, team: Pick<CatalogTeam, "requiredSkills">) {
  const text = reply.replace(/[*_`]/g, "").toLowerCase();
  const names = (skill: CatalogTeam["requiredSkills"][number]) => [skill.ref, skill.ref.replaceAll("-", " "),
    skill.catalogSkillId, skill.catalogSkillKey];
  return team.requiredSkills.every(skill => names(skill).some(name => !!name && text.includes(name.toLowerCase())));
}
/** The web app routes no teams catalog page, so a /teams-catalog link opens Page not found. */
export function linksMissingTeamCatalogPage(o: { links: string[]; origin: string }) {
  return o.links.some(href => { try { return new URL(href, o.origin).pathname.split("/").includes("teams-catalog"); } catch { return false; } });
}
// The reply's summary of roles, requirements and counts is read by a person; it is
// not matched with keywords. Grading uses the run's own catalog reads, the saved
// state and the preview the product computes. The web app has no catalog page to link.
export function gradeTeams(value: unknown) {
  const c = checks(); const o = externalObservation(value);
  c.add("complete-team-catalog-evidence", !!o, "Public catalog metadata, before/after company resources and reply links are required."); if (!o) return c.result();
  const team = o.state.team as CatalogTeam | undefined;
  const operations = o.state.runEventsRead === true && Array.isArray(o.state.teamApiOperations) ? o.state.teamApiOperations as string[] : undefined;
  c.add("existing-package-grounding", !!team && team.compatibility === "compatible" && team.agentSlugs.length >= 2 && team.counts.projects > 0
    && !!operations?.some(operation => LIST_TEAMS.has(operation)), "The agent read the real teams catalog in its own run before answering.");
  c.add("names-catalog-team", !!team && namesCatalogTeam(o.reply, team), "The reply identifies the selected catalog team by a name, slug or id the catalog returned.");
  // The expected outcome calls out requirements in the package metadata. The required skill refs are
  // catalog literals, so naming each one is an identity check, not wording.
  if (o.scenarioId === "teams.find-team") c.add("names-required-skills", !!team && team.requiredSkills.length > 0 && namesRequiredSkills(o.reply, team),
    "The reply names every required skill the catalog lists for the recommended team.");
  c.add("no-broken-catalog-link", !linksMissingTeamCatalogPage(o), "The reply does not link a teams catalog page, which the web app does not route.");
  c.add("no-premature-installation", sameRows(o.state.installedBefore, o.state.installedAfter) && sameRows(o.state.agentIdsBefore, o.state.agentIdsAfter)
    && sameRows(o.state.projectIdsBefore, o.state.projectIdsAfter) && !operations?.includes(INSTALL_TEAM),
    "Catalog discovery and preview cannot create agents, projects or an installation.");
  if (o.scenarioId === "teams.preview-install") {
    const preview = o.state.preview as CatalogTeamImportPreviewResult | undefined;
    c.add("preview-requirements-grounded", !!preview && preview.team.contentHash === team?.contentHash && Array.isArray(preview.errors),
      "The product's own preview of the selected package is current and readable.");
    c.add("preview-resources-described", !!operations?.includes(PREVIEW_TEAM), "The agent ran the supported install preview in its own run instead of describing an install from memory.");
  }
  return c.result();
}
export const teamExternalCases = ["find-team", "preview-install"].map(id => definition(`teams.${id}`, async ctx => {
  const catalog = await ctx.input.api.get<CatalogTeam[]>("/api/teams/catalog");
  const team = catalog.find(row => row.slug === "product-engineering" && row.compatibility === "compatible");
  if (!team || team.agentSlugs.length < 2 || team.counts.projects < 1) throw new Error("Setup blocker: supported Product Engineering catalog package with agents/project is absent");
  const [agents, projects, installed] = await Promise.all([
    ctx.input.api.get<Array<{ id: string }>>(`${root(ctx)}/agents`), ctx.input.api.get<Array<{ id: string }>>(`${root(ctx)}/projects`),
    ctx.input.api.get(`${root(ctx)}/teams/catalog/installed`),
  ]);
  // Context selection is a prerequisite, not a preview or installation result.
  await ctx.input.api.post(`${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`); await ctx.refreshIssue();
  if (!ctx.issue()) throw new Error("Standing chat context was not created");
  await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `We are choosing a team to build a website. ${id === "preview-install" ? `The selected package is ${team.name}, catalog key ${team.key}. No installation has been accepted.` : "No package has been installed."}` });
  return { team, agentIdsBefore: agents.map(row => row.id).sort(), projectIdsBefore: projects.map(row => row.id).sort(), installedBefore: installed,
  };
}, gradeTeams, {
  async observe(ctx, state) {
    const [agents, projects, installed] = await Promise.all([
      ctx.input.api.get<Array<{ id: string }>>(`${root(ctx)}/agents`), ctx.input.api.get<Array<{ id: string }>>(`${root(ctx)}/projects`),
      ctx.input.api.get(`${root(ctx)}/teams/catalog/installed`),
    ]);
    state.agentIdsAfter = agents.map(row => row.id).sort(); state.projectIdsAfter = projects.map(row => row.id).sort(); state.installedAfter = installed;
    if (id === "preview-install") state.preview = await ctx.input.api.post(`${root(ctx)}/teams/catalog/${encodeURIComponent((state.team as CatalogTeam).id)}/preview`, { targetManagerAgentId: ctx.input.fixtures.agent.id });
    const events: { seq?: number; payload?: Record<string, unknown> | null }[] = [];
    for (const run of await ctx.allRuns()) events.push(...await collectRunEvents<{ seq?: number; payload?: Record<string, unknown> | null }>((afterSeq, limit) =>
      ctx.input.api.getRunObservation(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`)));
    state.runEventsRead = true; state.teamApiOperations = teamApiOperations(events);
    return observeExternal(ctx, state);
  },
  // The reply is the result: the catalog has no web page to open from it.
  async verifyResult(ctx, _state, value) { await verifyRenderedReply(ctx, value); },
  oracleVersion: "paperclip.chat-catalog.team-discovery.v3",
  sourceFiles: ["chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/external-teams.ts",
    "chat-scenarios/teams.yaml", "run-observations.ts"],
}));
