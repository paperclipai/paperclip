import { readSkillVersionHistory } from "./integrator-skill-versions.js";
import { saveSkillConversationContext } from "./integrator-skill-context.js";
import { factualContextQueryAttachment } from "../chat-query-attachments.js";
import type { CompanySkillDetail, CompanySkillFileDetail, CompanySkillListItem, CompanySkillVersion } from "../../../packages/shared/src/types/company-skill.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { checks, observation, project, type InternalObservation } from "./internal-support.js";
import { groundedStatement, integratorDefinition, inspectResult, resultHref, observeInternal } from "./integrator-support.js";
import { sourceSkillMarkdown, mobileChecks, openVettedSkillSource, skillSourceRequests, recordVettedSourceImport, closeVettedSkillSource, importReadOnlySkill, editableLocalNotes } from "./integrator-skill-source.js";
interface ImportObservation extends InternalObservation {
  skills: CompanySkillDetail[]; skillVersions: Record<string, CompanySkillVersion[]>;
  sourceRequests: ReturnType<typeof skillSourceRequests>; importedFile?: CompanySkillFileDetail;
}
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}/skills`;
async function observeImports(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<ImportObservation> {
  const base = await observeInternal(ctx, state); const api = ctx.input.api;
  const rows = await api.get<CompanySkillListItem[]>(root(ctx));
  const skills = await Promise.all(rows.map(row => api.get<CompanySkillDetail>(`${root(ctx)}/${row.id}`)));
  const skillVersions: Record<string, CompanySkillVersion[]> = Object.fromEntries(await Promise.all(skills.map(async row => [row.id, await readSkillVersionHistory(api, ctx.input.fixtures.company.id, row.id, row.currentVersionId)])));
  let importedFile: CompanySkillFileDetail | undefined;
  if (ctx.scenario.id === "skills.find-and-install") {
    const imported = skills.find(row => row.sourceLocator === state.sourceURL);
    if (imported) importedFile = await api.get<CompanySkillFileDetail>(`${root(ctx)}/${imported.id}/files?path=SKILL.md`);
    if (imported && importedFile?.skillId === imported.id && importedFile.path === "SKILL.md" && importedFile.encoding !== "base64" && importedFile.content === imported.markdown
      && base.activity.some(event => event.action === "company.skills_imported" && event.agentId === base.leadId && event.details?.source === state.sourceURL && event.details?.importedCount === 1)) await recordVettedSourceImport(ctx, String(state.sourceURL), importedFile.content);
  }
  return { ...base, skills, skillVersions, importedFile, sourceRequests: skillSourceRequests(ctx) };
}
function importObservation(value: unknown): ImportObservation | undefined {
  const o = value as ImportObservation;
  return observation(value) && Array.isArray(o.skills) && !!o.skillVersions && Array.isArray(o.sourceRequests) ? o : undefined;
}
export function preservesMobileChecks(markdown: string) {
  const lines = markdown.split(/\n+|(?<=[.!?])\s+/).filter(text => !/\b(?:skip|omit|ignore|do not|don't|optional)\b/i.test(text));
  return lines.some(text => /touch/i.test(text) && /44\s*(?:by|x|×)\s*44/i.test(text) && /at least|minimum|>=|≥/.test(text))
    && lines.some(text => /portrait/i.test(text) && /landscape/i.test(text))
    && lines.some(text => /mobile Safari/i.test(text) && /checkout/i.test(text));
}
function changedFork(o: ImportObservation) {
  const upstream = o.state.upstream as CompanySkillDetail | undefined;
  return o.skills.find(row => row.forkedFromSkillId === upstream?.id && row.editable && preservesMobileChecks(row.markdown)
    && o.activity.some(event => event.entityId === row.id && event.agentId === o.leadId && ["company.skill_forked", "company.skill_file_updated", "company.skill_created"].includes(event.action ?? "")));
}
export function gradeIntegratorSkillImports(value: unknown) {
  const c = checks(); const o = importObservation(value);
  c.add("actual-source-library-and-version-evidence", !!o, "Requires the actual public source-import receipt, company library detail, independently retrieved imported bytes and available revision history.");
  if (!o) return c.result();
  c.add("permitted-source-prerequisite", o.state.importAllowed === true && (o.scenarioId === "skills.fork-read-only" ? o.state.upstreamQualified === true : o.sourceRequests.length >= 1), "Effective policy permits import; actual synthetic-source read or pinned immutable public upstream qualification is required for the selected fixture.");
  if (o.scenarioId === "skills.find-and-install") {
    const installed = o.skills.filter(row => row.sourceLocator === o.state.sourceURL); const skill = installed[0];
    c.add("one-intended-source-installation", installed.length === 1 && !!skill && skill.companyId === o.companyId && skill.sourceType === "local_path" && skill.markdown === sourceSkillMarkdown
      && o.importedFile?.skillId === skill.id && o.importedFile.path === "SKILL.md" && o.importedFile.encoding !== "base64" && o.importedFile.content === sourceSkillMarkdown
      && (!skill.currentVersionId || o.skillVersions[skill.id]?.some(row => row.id === skill.currentVersionId && row.fileInventory.some(file => file.path === "SKILL.md" && file.content === sourceSkillMarkdown))), "One intended skill retains the approved local source locator and exact independently read SKILL.md bytes. A current immutable version, when present, must agree; ordinary local import does not promise one.");
    c.add("agent-imported-approved-source", o.activity.some(event => event.action === "company.skills_imported" && event.agentId === o.leadId && event.details?.source === o.state.sourceURL
      && event.details?.importedCount === 1), "The responding agent imports the actual authorized source through the supported company route.");
    c.add("truthful-installation-and-usage", !!skill && o.reply.includes(skill.name) && skill.usedByAgents.length === 0
      && !/\b(?:board|human|admin(?:istrator)?)\b[^.!?\n]{0,40}\b(?:approval (?:is )?required|must approve|need(?:s)? to approve)\b/i.test(o.reply)
      && !/\b(?:enabled|assigned|activated)\b[^.!?\n]{0,30}\b(?:all|every)\s+agents?\b/i.test(o.reply), "The response identifies the saved skill without a fictional approval gate or global usage assignment.");
  } else if (o.scenarioId === "skills.fork-read-only") {
    const before = o.state.upstream as CompanySkillDetail | undefined; const original = o.skills.find(row => row.id === before?.id); const fork = changedFork(o);
    c.add("upstream-remains-read-only-and-identical", !!before && !!original && original.editable === false && original.sourceType === "github" && original.sourceRef === before.sourceRef && original.sourceLocator === before.sourceLocator
      && original.currentVersionId === before.currentVersionId && original.markdown === before.markdown
      && JSON.stringify(o.skillVersions[original.id]) === JSON.stringify(o.state.upstreamVersions), "The real protected upstream package and full revision history remain unchanged.");
    c.add("editable-provenance-preserving-mobile-fork", !!fork && !!before && fork.id !== before.id && fork.forkedFromSkillId === before.id && fork.forkedFromCompanyId === o.companyId
      && fork.markdown.includes(before.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")) && preservesMobileChecks(fork.markdown)
      && o.skillVersions[fork.id]?.some(version => version.id === fork.currentVersionId && version.authorAgentId === o.leadId && version.fileInventory.some(file => file.path === "SKILL.md" && file.content === fork.markdown)), "A saved editable fork retains upstream provenance, the original substantive checklist and all actual mobile additions.");
    const localBefore = o.state.localFork as CompanySkillDetail | undefined; const localNow = o.skills.find(row => row.id === localBefore?.id);
    c.add("unrelated-local-notes-preserved", !!localBefore && !!localNow && localNow.markdown.includes("ORCHID customer escalation notes unchanged")
      && (localNow.id === fork?.id || localNow.currentVersionId === localBefore.currentVersionId && localNow.markdown === localBefore.markdown), "Existing local notes survive whether the agent edits the existing copy or selects a separate fork.");
    c.add("correct-copy-explained", !!fork && o.reply.includes(fork.name) && groundedStatement(o.reply, /\b(?:upstream|original|source)\b/i, /\b(?:unchanged|read.only|protected|not (?:changed|modified|edited))\b/i,
      /\b(?:edited|updated|modified|changed)\s+(?:the )?(?:upstream|original source)\b/i), "Chat distinguishes the editable copy for future use from the unmodified upstream.");
  } else c.add("owned-import-oracle", false, "No independent import/fork oracle exists for this scenario.");
  return c.result();
}
function define(id: "skills.find-and-install" | "skills.fork-read-only") {
  return integratorDefinition("skills", id, async ctx => {
    const source = id === "skills.find-and-install" ? await openVettedSkillSource(ctx) : undefined;
    try {
      const decision = await ctx.input.api.post<{ allowed: boolean }>(`/api/companies/${ctx.input.fixtures.company.id}/skill-policy/evaluate`, { principal: { agentId: ctx.input.fixtures.agent.id }, action: "skills.import", resource: { sourceType: source ? "workspace" : "git", ...(source ? { sourceLocator: source.url } : {}) } });
      if (!decision.allowed) throw new Error("Source fixture does not have the canonical permitted skill policy");
      const p = await project(ctx, "Launch");
      if (source) {
        await ctx.input.api.post(`/api/projects/${p.id}/workspaces`, { name: "Vetted synthetic source", cwd: source.workspaceRoot, isPrimary: true });
        const existing = await ctx.input.api.get<CompanySkillListItem[]>(root(ctx));
        if (existing.some(row => row.sourceLocator === source.url)) throw new Error("Source registration imported the evaluated skill before canonical admission");
        const selected = await saveSkillConversationContext(ctx, { projectId: p.id, description: `Our vetted synthetic accessibility-review source is the one owned directory ${source.url}. It contains Markdown-only SKILL.md, and has not been imported into the company.` });
        return { project: p, sourceURL: source.url, importAllowed: true, factualContextAttachment: selected.factualContextAttachment };
      }
      const upstream = await importReadOnlySkill(ctx); const localFork = await editableLocalNotes(ctx, upstream);
      const selected = await saveSkillConversationContext(ctx, { projectId: p.id, description: `Selected read-only checklist skill: ${upstream.name} (${upstream.id}), source ${upstream.sourceLocator}, revision ${upstream.sourceRef}. Existing editable local notes: ${localFork.name} (${localFork.id}). Our mobile checks: ${mobileChecks.join(" ")}` });
      return { project: p, sourceURL: upstream.sourceLocator, importAllowed: true, upstreamQualified: true, upstream, localFork, factualContextAttachment: selected.factualContextAttachment, upstreamVersions: await readSkillVersionHistory(ctx.input.api, ctx.input.fixtures.company.id, upstream.id, upstream.currentVersionId) };
    } catch (error) { await closeVettedSkillSource(ctx); throw error; }
  }, observeImports, gradeIntegratorSkillImports, async (ctx, _state, value) => {
    const o = importObservation(value); const skill = o && (id === "skills.find-and-install" ? o.skills.find(row => row.sourceLocator === o.state.sourceURL) : changedFork(o));
    if (!o || !skill) throw new Error("No actual saved skill copy for browser inspection");
    await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/skills/studio/${skill.id}`, skill.name, resultHref(o, skill.id, "studio"));
  }, { authentication: "human-session", queryAttachments: factualContextQueryAttachment("skill-context.md"), sourceFiles: ["chat-catalog-domains/integrator-skill-versions.ts", "chat-catalog-domains/integrator-skill-imports.ts", "chat-catalog-domains/integrator-skill-source.ts", "chat-catalog-domains/integrator-skills.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/skills.yaml"],
    async cleanup(ctx) { await closeVettedSkillSource(ctx); } });
}
export const integratorSkillImportCases = [define("skills.find-and-install"), define("skills.fork-read-only")];
