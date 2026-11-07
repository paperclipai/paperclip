import { readFileSync } from "node:fs";
import { accessibilityUpdatePins } from "./integrator-skill-pins.js";
import { describe, expect, it } from "vitest";
import { gradeIntegratorSkillImports, integratorSkillImportCases, preservesMobileChecks } from "./integrator-skill-imports.js";
import { sourceSkillMarkdown, mobileChecks } from "./integrator-skill-source.js";
function valid(id: string) {
  const find = id === "skills.find-and-install";
  const url = find ? "/owned/vetted-candidates/accessibility-review" : accessibilityUpdatePins.repositoryURL;
  const originalMarkdown = find ? sourceSkillMarkdown : readFileSync(new URL("../fixtures/accessibility-source/0.4.SKILL.md", import.meta.url), "utf8");
  const upstream = { id: "upstream", companyId: "company", name: "accessibility-review", sourceLocator: url, sourceType: find ? "local_path" : "github", sourceRef: find ? null : accessibilityUpdatePins.oldCommit, editable: find, markdown: originalMarkdown, currentVersionId: "original", usedByAgents: [] };
  const version = { id: "original", fileInventory: [{ path: "SKILL.md", content: originalMarkdown }] };
  const local = { ...upstream, id: "local", name: "Accessibility local notes", sourceType: "local_path", editable: true, forkedFromSkillId: "upstream", forkedFromCompanyId: "company", markdown: `${originalMarkdown}\nKeep ORCHID customer escalation notes unchanged.`, currentVersionId: "notes" };
  const fork = { ...local, markdown: `${local.markdown}\n${mobileChecks.join("\n")}`, currentVersionId: "edited" };
  return { scenarioId: id, origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { sourceURL: url, importAllowed: true, upstreamQualified: !find, upstream: structuredClone(upstream), localFork: structuredClone(local), upstreamVersions: [structuredClone(version)] },
    tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], links: [], runs: [{ id: "run", agentId: "ceo", status: "succeeded" }],
    activity: find ? [{ id: "import", action: "company.skills_imported", agentId: "ceo", details: { source: url, importedCount: 1 } }] : [{ id: "edit", action: "company.skill_file_updated", agentId: "ceo", entityId: "local" }],
    importedFile: find ? { skillId: "upstream", path: "SKILL.md", content: sourceSkillMarkdown } : undefined,
    sourceRequests: [{ method: "GET", path: "/accessibility-review/SKILL.md", at: 1, sha256: "digest" }],
    skills: find ? [upstream] : [upstream, fork], skillVersions: find ? { upstream: [version] } : { upstream: [version], local: [{ id: "edited", authorAgentId: "ceo", fileInventory: [{ path: "SKILL.md", content: fork.markdown }] }] },
    reply: find ? "Installed accessibility-review from the vetted source. Assignment is a separate step." : "Use Accessibility local notes for future assignments. The upstream original is unchanged and remains read-only." };
}
describe("owned vetted source and editable fork controls", () => {
  for (const definition of integratorSkillImportCases) it(`${definition.scenarioId}: saved source/version evidence and missing inputs`, () => {
    expect(gradeIntegratorSkillImports(valid(definition.scenarioId)).passed).toBe(true);
    expect(gradeIntegratorSkillImports(undefined).passed).toBe(false);
    if (definition.scenarioId === "skills.find-and-install") expect(gradeIntegratorSkillImports({ ...valid(definition.scenarioId), sourceRequests: [] }).passed).toBe(false);
    else expect(gradeIntegratorSkillImports({ ...valid(definition.scenarioId), state: { ...valid(definition.scenarioId).state, upstreamQualified: false } }).passed).toBe(false);
  });
  it("rejects a substituted source, fetch-without-install and fictional board approval", () => {
    const o = valid("skills.find-and-install");
    expect(gradeIntegratorSkillImports({ ...o, activity: [] }).passed).toBe(false);
    expect(gradeIntegratorSkillImports({ ...o, importedFile: undefined }).passed).toBe(false);
    expect(gradeIntegratorSkillImports({ ...o, importedFile: { ...o.importedFile!, skillId: "another-skill" } }).passed).toBe(false);
    const localNoSnapshot = structuredClone(o); localNoSnapshot.skills[0]!.currentVersionId = ""; localNoSnapshot.skillVersions.upstream = [];
    expect(gradeIntegratorSkillImports(localNoSnapshot).passed).toBe(true);
    const replaced = structuredClone(o); replaced.skills[0]!.sourceLocator = "http://other.test/SKILL.md";
    expect(gradeIntegratorSkillImports(replaced).passed).toBe(false);
    expect(gradeIntegratorSkillImports({ ...o, reply: "Board approval is required to install accessibility-review." }).passed).toBe(false);
    const wrongBytes = structuredClone(o); wrongBytes.skills[0]!.markdown = "A suggested skill.";
    expect(gradeIntegratorSkillImports(wrongBytes).passed).toBe(false);
  });
  it("rejects upstream edits, lost unrelated local notes, missing substantive mobile checks and false in-place success", () => {
    const o = valid("skills.fork-read-only"); const upstreamChanged = structuredClone(o); upstreamChanged.skills[0]!.markdown += "Modified upstream";
    expect(gradeIntegratorSkillImports(upstreamChanged).passed).toBe(false);
    const lostNotes = structuredClone(o); lostNotes.skills[1]!.markdown = `${sourceSkillMarkdown}\n${mobileChecks.join("\n")}`;
    expect(gradeIntegratorSkillImports(lostNotes).passed).toBe(false);
    const wrongTouch = structuredClone(o); wrongTouch.skills[1]!.markdown = wrongTouch.skills[1]!.markdown.replace("44 by 44", "24 by 24");
    expect(gradeIntegratorSkillImports(wrongTouch).passed).toBe(false);
    expect(gradeIntegratorSkillImports({ ...o, reply: "I edited the upstream. Use Accessibility local notes; the original is unchanged." }).passed).toBe(false);
    expect(preservesMobileChecks("Check touch targets at least 44x44 pixels.\nCheck both portrait and landscape orientation.\nReview mobile Safari checkout.")).toBe(true);
    expect(preservesMobileChecks("Ignore touch targets at least 44x44 pixels.\nCheck both portrait and landscape orientation.\nReview mobile Safari checkout.")).toBe(false);
  });
});
