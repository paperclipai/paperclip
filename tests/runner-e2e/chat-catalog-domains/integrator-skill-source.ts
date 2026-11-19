import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { SkillSourceRefreshResult } from "../../../packages/shared/src/types/skill-source.js";
import { accessibilityUpdatePins } from "./integrator-skill-pins.js";
import { createHash } from "node:crypto";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { CompanySkill, CompanySkillDetail } from "../../../packages/shared/src/types/company-skill.js";
import { websiteChecklist } from "./integrator-skills.js";
export const sourceSkillMarkdown = `---\nname: accessibility-review\ndescription: Review a synthetic website for accessibility and report evidence.\n---\n\n# Website accessibility review\n\n${websiteChecklist.map(item => `- ${item}`).join("\n")}\n\nFor each check, record the page and observed evidence; report failures without claiming every page was tested.\n`;
export const mobileChecks = ["Check touch targets are at least 44 by 44 pixels.", "Repeat the review in both portrait and landscape orientation.", "Verify the checkout interaction on mobile Safari."];
const sources = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof openSource>>>();
async function openSource() {
  const directory = await mkdtemp(path.join(tmpdir(), "paperclip-vetted-accessibility-"));
  const skillDirectory = path.join(directory, "vetted-candidates", "accessibility-review");
  await mkdir(skillDirectory, { recursive: true });
  const file = path.join(skillDirectory, "SKILL.md");
  await writeFile(file, sourceSkillMarkdown, { mode: 0o600 });
  return { url: skillDirectory, workspaceRoot: directory, requests: [] as Array<{ method: string; path: string; at: number; sha256: string }>,
    async close() { await rm(directory, { recursive: true, force: true }); } };
}
export async function openVettedSkillSource(ctx: ChatCatalogContext) {
  if (sources.has(ctx)) throw new Error("Only one owned synthetic skill source is allowed per attempt");
  const source = await openSource(); sources.set(ctx, source); return source;
}
/** A source-read receipt is derived only after the evaluated public import,
 * never prepopulated by setup. The actual source bytes, saved revision and
 * agent-attributed import must agree before the caller records it. */
export async function recordVettedSourceImport(ctx: ChatCatalogContext, source: string, markdown: string) {
  const owned = sources.get(ctx); if (!owned || owned.url !== source) return;
  const actual = await readFile(path.join(owned.url, "SKILL.md"), "utf8");
  if (actual !== sourceSkillMarkdown || actual !== markdown) throw new Error("Vetted source bytes drifted from actual imported revision");
  if (!owned.requests.length) owned.requests.push({ method: "public-local-import", path: "SKILL.md", at: Date.now(), sha256: createHash("sha256").update(actual).digest("hex") });
}
export function skillSourceRequests(ctx: ChatCatalogContext) { return sources.get(ctx)?.requests.map(row => ({ ...row })) ?? []; }
export async function closeVettedSkillSource(ctx: ChatCatalogContext) { const source = sources.get(ctx); if (source) { await source.close(); sources.delete(ctx); } }
/** Genuine public immutable upstream; local filesystem mode bits are never
 * presented as product-level read-only provenance. */
export async function importReadOnlySkill(ctx: ChatCatalogContext): Promise<CompanySkillDetail> {
  const pins = accessibilityUpdatePins;
  const response = await fetch(`https://raw.githubusercontent.com/KreerC/ACCESSIBILITY.md/${pins.oldCommit}/${pins.path}`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Pinned public read-only checklist source unavailable"); }
  const markdown = await response.text();
  if (createHash("sha256").update(markdown).digest("hex") !== pins.oldSha256) throw new Error("Pinned public checklist content changed");
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const imported = await ctx.input.api.post<SkillSourceRefreshResult>(`${root}/skill-sources`, { repositoryUrl: pins.repositoryURL, trackingRef: pins.oldCommit, commitSha: pins.oldCommit, selectedPaths: [pins.path], excludedFolders: [] });
  if (imported.source.lastScanCommit !== pins.oldCommit || imported.imported.length !== 1 || !imported.source.entries.some(entry => entry.path === pins.path && entry.skillId === imported.imported[0]?.id)) throw new Error("Pinned source must produce one actual read-only checklist");
  const skill = await ctx.input.api.get<CompanySkillDetail>(`${root}/skills/${imported.imported[0]!.id}`);
  if (skill.sourceType !== "github" || skill.sourceRef !== pins.oldCommit || skill.editable || skill.markdown !== markdown || !skill.currentVersionId) throw new Error("Actual read-only checklist identity/content/version was not established");
  return skill;
}
export async function editableLocalNotes(ctx: ChatCatalogContext, upstream: CompanySkillDetail) {
  const root = `/api/companies/${ctx.input.fixtures.company.id}/skills`;
  const result = await ctx.input.api.post<{ skill: CompanySkill }>(`${root}/${upstream.id}/fork`, { name: "Accessibility local notes", slug: "accessibility-local-notes" });
  await ctx.input.api.patch(`${root}/${result.skill.id}/files`, { path: "SKILL.md", content: `${result.skill.markdown.replace(/^name:[^\n]*$/m, "name: accessibility-local-notes")}\n\n## Local review notes\nKeep ORCHID customer escalation notes unchanged.\n`, expectedVersionId: result.skill.currentVersionId });
  return ctx.input.api.get<CompanySkillDetail>(`${root}/${result.skill.id}`);
}
