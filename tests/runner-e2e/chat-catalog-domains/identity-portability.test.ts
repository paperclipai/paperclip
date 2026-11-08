import { describe, expect, it } from "vitest";
import { gradePortability, savedAgentConfiguration } from "./identity-portability.js";
import type { IdentityObservation } from "./identity-support.js";
function valid(scenarioId: string): IdentityObservation {
  const o: IdentityObservation = { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], tasks: [], projects: [], goals: [], comments: [], interactions: [], documents: [], revisions: [], activity: [], links: [], runs: [], humanQueries: [], reply: "Secrets are excluded; supply EXPORT_FIXTURE_KEY when importing.", state: {} };
  if (scenarioId.endsWith("export-company")) {
    o.runs = [{ id: "export", companyId: "acorn", agentId: "ceo", status: "succeeded" }];
    o.company = { id: "acorn", name: "Acorn" };
    o.state = { sourceId: "chat", originalAgentName: "CEO", secretKey: "EXPORT_FIXTURE_KEY", secretName: "Export prerequisite API key", exportAttachment: { id: "package", companyId: "acorn", issueId: "chat", createdByAgentId: "ceo", originatingRunId: "export", sha256: "bytes" },
      downloadSha256: "bytes", actualDownloadStatus: 200, fileVisible: true, agentExportPermissionStatus: 200, packageContainsPrivateValue: false, noForeignScope: true,
      actualPackagePreview: { errors: [], manifest: { source: null, company: { name: "Acorn" }, agents: [{ name: "CEO" }], projects: [{ name: "Launch" }], skills: [{ slug: "launch-checklist" }] },
        files: { "COMPANY.md": "Acorn", "agents/ceo/AGENTS.md": "CEO", "skills/launch-checklist/SKILL.md": "Checklist" }, envInputs: [{ key: "EXPORT_FIXTURE_KEY", kind: "secret", requirement: "optional", defaultValue: "" }] } };
  } else {
    o.state = { existing: { id: "morgan" }, preview: { targetCompanyId: "acorn", errors: [], plan: { agentPlans: [{ slug: "morgan", existingAgentId: "morgan", action: "create" }] } },
      beforeChoiceUnchanged: true, firstTurnAwaitedHuman: true, firstReply: "Previewed (nothing imported): adds 1 agent, Morgan. Slug `morgan` already exists here, so the default rename plans it as Morgan 2 instead of overwriting the existing employee.", actualPackageAttached: true, importedAgentId: "new", existingConfigurationUnchanged: true, existingStillPresent: true, importedAgentVisible: true };
    o.humanQueries = ["Show me what this company package would add before importing it.", "Rename the incoming employee Morgan Package and import it."];
    o.agents = [{ id: "morgan", name: "Morgan", companyId: "acorn" }, { id: "new", name: "Morgan Package", companyId: "acorn" }];
    o.activity = [{ id: "import", action: "company.imported", entityId: "acorn", agentId: "ceo", details: { importMode: "agent_safe" } }];
  }
  return o;
}
describe("actual company package download and conflict-safe import", () => {
  for (const id of ["companies.export-company", "companies.import-preview"]) {
    it(`${id}: valid and missing evidence`, () => { const o = valid(id); expect(gradePortability(o), JSON.stringify(gradePortability(o))).toMatchObject({ passed: true }); expect(gradePortability(undefined).passed).toBe(false); });
    it(`${id}: wrong scope or mutated original rejected`, () => { const o = valid(id); if (id.endsWith("export-company")) o.state.noForeignScope = false; else o.state.existingConfigurationUnchanged = false; expect(gradePortability(o).passed).toBe(false); });
  }
  it("does not accept prose or a link to an export page as a delivered CEO package", () => { const o = valid("companies.export-company"); delete o.state.exportAttachment; o.links = ["/ACO/company/export"]; expect(gradePortability(o).passed).toBe(false); });
  it("accepts the omitted credential named by its secret name instead of its key", () => { const o = valid("companies.export-company"); o.reply = "Your export prerequisite API key was left out; add it after import."; expect(gradePortability(o).passed).toBe(true); });
  it("rejects a reply that never names the omitted credential", () => { const o = valid("companies.export-company"); o.reply = "Exported the company setup as a reusable bundle."; expect(gradePortability(o).passed).toBe(false); });
  it("rejects a package from another company or one carrying the credential value as a default", () => {
    const foreign = valid("companies.export-company"); (foreign.state.actualPackagePreview as { manifest: { company: { name: string } } }).manifest.company.name = "Other Co"; expect(gradePortability(foreign).passed).toBe(false);
    const valued = valid("companies.export-company"); (valued.state.actualPackagePreview as { envInputs: Array<{ defaultValue: string }> }).envInputs[0]!.defaultValue = "value"; expect(gradePortability(valued).passed).toBe(false);
  });
  it("rejects secret values in an otherwise supported package", () => { const o = valid("companies.export-company"); o.state.packageContainsPrivateValue = true; expect(gradePortability(o).passed).toBe(false); });
  it("rejects silently performing the import before human conflict choice", () => { const o = valid("companies.import-preview"); o.state.beforeChoiceUnchanged = false; expect(gradePortability(o).passed).toBe(false); });
  it("rejects a replaced employee despite identical visible name", () => { const o = valid("companies.import-preview"); o.state.importedAgentId = "morgan"; expect(gradePortability(o).passed).toBe(false); });
  it("accepts a reworded first preview that surfaces the conflict without the old keywords", () => {
    const o = valid("companies.import-preview"); o.state.firstReply = "Nothing has been imported yet. The package brings one engineer, Morgan, but you already employ a Morgan; tell me what the newcomer should be called, or whether to leave it out.";
    expect(gradePortability(o).passed).toBe(true);
  });
  it("rejects a first turn that never surfaces the conflicting employee or that did not stop for the person", () => {
    const silent = valid("companies.import-preview"); silent.state.firstReply = "The package adds one engineer. Ready when you are."; expect(gradePortability(silent).passed).toBe(false);
    const kept = valid("companies.import-preview"); kept.state.firstTurnAwaitedHuman = false; expect(gradePortability(kept).passed).toBe(false);
  });
  it("compares saved configuration without lifecycle status or timestamps, but catches an overwrite", () => {
    const before = { name: "Morgan", adapterType: "paperclip_runner", adapterConfig: { model: "m" }, configurationRevision: "a", status: "paused", updatedAt: "t1" };
    expect(savedAgentConfiguration({ ...before, status: "idle", updatedAt: "t2" })).toBe(savedAgentConfiguration(before));
    expect(savedAgentConfiguration({ ...before, adapterType: "process", configurationRevision: "b" })).not.toBe(savedAgentConfiguration(before));
  });
});
