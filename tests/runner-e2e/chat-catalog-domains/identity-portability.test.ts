import { describe, expect, it } from "vitest";
import { gradePortability } from "./identity-portability.js";
import type { IdentityObservation } from "./identity-support.js";
function valid(scenarioId: string): IdentityObservation {
  const o: IdentityObservation = { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], tasks: [], projects: [], goals: [], comments: [], interactions: [], documents: [], revisions: [], activity: [], links: [], runs: [], humanQueries: [], reply: "The package omits credentials; reconnect the runtime environment before use.", state: {} };
  if (scenarioId.endsWith("export-company")) {
    o.runs = [{ id: "export", companyId: "acorn", agentId: "ceo", status: "succeeded" }];
    o.state = { sourceId: "chat", originalAgentName: "CEO", exportAttachment: { id: "package", companyId: "acorn", issueId: "chat", createdByAgentId: "ceo", originatingRunId: "export", sha256: "bytes" },
      downloadSha256: "bytes", actualDownloadStatus: 200, fileVisible: true, agentExportPermissionStatus: 200, packageContainsPrivateValue: false, noForeignScope: true,
      actualPackagePreview: { errors: [], manifest: { source: { companyId: "acorn" }, agents: [{ name: "CEO" }], projects: [{ name: "Launch" }], skills: [{ slug: "launch-checklist" }] },
        files: { "COMPANY.md": "Acorn", "agents/ceo/AGENTS.md": "CEO", "skills/launch-checklist/SKILL.md": "Checklist" }, envInputs: [{ kind: "secret", requirement: "required" }] } };
  } else {
    o.state = { existing: { id: "morgan" }, preview: { targetCompanyId: "acorn", errors: [], plan: { agentPlans: [{ slug: "morgan", existingAgentId: "morgan", action: "create" }] } },
      beforeChoiceUnchanged: true, initialReplyAskedChoice: true, actualPackageAttached: true, importedAgentId: "new", existingConfigurationUnchanged: true, existingStillPresent: true, importedAgentVisible: true };
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
  it("rejects secret values in an otherwise supported package", () => { const o = valid("companies.export-company"); o.state.packageContainsPrivateValue = true; expect(gradePortability(o).passed).toBe(false); });
  it("rejects silently performing the import before human conflict choice", () => { const o = valid("companies.import-preview"); o.state.beforeChoiceUnchanged = false; expect(gradePortability(o).passed).toBe(false); });
  it("rejects a replaced employee despite identical visible name", () => { const o = valid("companies.import-preview"); o.state.importedAgentId = "morgan"; expect(gradePortability(o).passed).toBe(false); });
});
