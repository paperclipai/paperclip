import { describe, expect, it } from "vitest";
import { SKILL_POLICY_ACTIONS } from "../../../packages/shared/src/validators/skill-policy.js";
import { gradeIntegratorSkillEnable, integratorSkillEnableCases, unsupportedUsePrerequisite, skillEnableAuthorityReady } from "./integrator-skill-enable.js";
function valid() {
  const skill = { id: "skill", key: "company/accessibility-review", currentVersionId: "revision", markdown: "Check form labels" };
  return { scenarioId: "skills.enable-for-agent", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { skill: structuredClone(skill), worker: { id: "morgan" }, futureTask: { id: "future" }, agentConfigurationStatus: 200, configurationAuthority: { companyId: "company", principalId: "ceo", targetId: "morgan", targetCompanyId: "company", status: 200, membership: { companyId: "company", principalType: "agent", principalId: "ceo", status: "active" }, grants: [{ permissionKey: "agents:configure", scope: null as unknown }], before: { supported: true, desiredSkills: [] as string[], desiredSkillEntries: [] }, after: { supported: true, desiredSkills: [] as string[], desiredSkillEntries: [] } }, beforeActivityIds: ["setup-probe"], effectivePolicy: { revision: 1, rules: [] } },
    tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], links: [],
    runs: [{ id: "source", agentId: "ceo", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "chat" } }, { id: "future-run", agentId: "morgan", companyId: "company", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "future", skillVersions: { [skill.key]: "revision" } } }],
    skill, versions: [{ id: "revision", companyId: "company", companySkillId: "skill", fileInventory: [{ path: "SKILL.md", kind: "skill", content: skill.markdown }] }], assignment: { supported: true, desiredSkills: [skill.key], desiredSkillEntries: [{ key: skill.key, versionId: "revision" }] }, effectivePolicy: { revision: 1, rules: [] },
    activity: [{ id: "actual-assignment", action: "agent.skills_synced", agentId: "ceo", entityId: "morgan", runId: "source" }],
    reply: "Assigned the existing skill from our company library to Morgan. Installation was already complete; usage remains subject to the existing policy." };
}
describe("effective-use prerequisite classification", () => {
  it("requires the complete real lifecycle-denial probe and actual retained assignment, never a single unsupported action", () => {
    const receipt = { useStatus: 400, decisions: SKILL_POLICY_ACTIONS.map(action => ({ action, allowed: false })), assignmentRetained: true };
    expect(unsupportedUsePrerequisite(receipt)).toBe(true);
    expect(unsupportedUsePrerequisite({ ...receipt, decisions: [] })).toBe(false);
    expect(unsupportedUsePrerequisite({ ...receipt, useStatus: 403 })).toBe(false);
    expect(unsupportedUsePrerequisite({ ...receipt, assignmentRetained: false })).toBe(false);
    expect(unsupportedUsePrerequisite({ ...receipt, decisions: receipt.decisions.map((row, index) => index ? row : { ...row, allowed: true }) })).toBe(false);
  });
});
describe("actual permitted skill assignment and future immutable delivery", () => {
  it("requires actual CEO configuration while leaving denied-use coverage conditional", () => {
    expect(integratorSkillEnableCases[0]!.coverageGaps?.length ?? 0).toBe(0);
    expect(gradeIntegratorSkillEnable(valid()).passed).toBe(true);
    expect(gradeIntegratorSkillEnable({ ...valid(), state: { ...valid().state, agentConfigurationStatus: 403 } }).passed).toBe(false);
    expect(gradeIntegratorSkillEnable(undefined).passed).toBe(false);
  });
  it("rejects a different agent/version, setup-probe attribution and policy self-elevation", () => {
    const stale = valid(); stale.runs[1]!.contextSnapshot.skillVersions = { [stale.skill.key]: "old-version" };
    expect(gradeIntegratorSkillEnable(stale).passed).toBe(false);
    const wrong = valid(); wrong.runs[1]!.agentId = "someone-else"; expect(gradeIntegratorSkillEnable(wrong).passed).toBe(false);
    const probe = valid(); probe.activity[0]!.id = "setup-probe"; expect(gradeIntegratorSkillEnable(probe).passed).toBe(false);
    const changed = valid(); changed.effectivePolicy.revision = 2; expect(gradeIntegratorSkillEnable(changed).passed).toBe(false);
  });
  it("does not turn a completed positive context into permission to omit the actual skill or authority", () => {
    const missing = valid(); missing.assignment.desiredSkills = []; expect(gradeIntegratorSkillEnable(missing).passed).toBe(false);
    const foreign = valid(); foreign.state.configurationAuthority.targetCompanyId = "foreign"; expect(gradeIntegratorSkillEnable(foreign).passed).toBe(false);
    const unauthorized = valid(); unauthorized.state.configurationAuthority.status = 403; expect(gradeIntegratorSkillEnable(unauthorized).passed).toBe(false);
  });
  it("grades the saved assignment, not the reply's wording", () => {
    const retained = "Done — the `accessibility-review` skill is enabled for **Morgan**. Her skill list now shows it as `desired: true`; it will be materialized into her workspace on her next run.\n\nNote: a specific version pin was rejected because Beta skill versioning isn't enabled, so the current available version was assigned (which auto-tracks the latest).";
    for (const reply of [retained, "Morgan has the accessibility review skill now and will pick it up on her next task.", "Previously Morgan could not use the skill, but Morgan can now use it on future work."])
      expect(gradeIntegratorSkillEnable({ ...valid(), reply }).passed).toBe(true);
  });
  it("rejects configuring another agent, a missing reply and an unsaved assignment whatever the reply says", () => {
    const other = valid(); other.activity.push({ ...other.activity[0]!, id: "other-agent", entityId: "riley" });
    expect(gradeIntegratorSkillEnable(other).passed).toBe(false);
    expect(gradeIntegratorSkillEnable({ ...valid(), reply: "  " }).passed).toBe(false);
    const unsaved = valid(); unsaved.assignment.desiredSkills = []; unsaved.reply = "Morgan is enabled.";
    expect(gradeIntegratorSkillEnable(unsaved).passed).toBe(false);
  });
});

it("accepts a genuine execution snapshot of unchanged initially unversioned local bytes", () => {
 const o = valid(); (o.state.skill as {currentVersionId: string | null}).currentVersionId = null;
 expect(gradeIntegratorSkillEnable(o).passed).toBe(true);
 o.versions[0]!.fileInventory[0]!.content = "Different instructions";
 expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
});
it.each(["companyId", "companySkillId", "id"])("rejects a foreign or unselected version %s", field => {
 const o = valid(); (o.versions[0] as Record<string, unknown>)[field] = "wrong";
 expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
});

describe("existing standard CEO authority and actual target no-op", () => {
  for (const [field, value] of [["companyId", "foreign"], ["principalId", "board"], ["targetId", "other"], ["targetCompanyId", "foreign"], ["status", 403]] as const) it(`rejects mismatched authority ${field}`, () => {
    const o = valid(); Object.assign(o.state.configurationAuthority, { [field]: value }); expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
  });
  for (const [field, value] of [["principalType", "user"], ["principalId", "other"], ["companyId", "foreign"], ["status", "suspended"]] as const) it(`rejects mismatched membership ${field}`, () => {
    const o = valid(); Object.assign(o.state.configurationAuthority.membership, { [field]: value }); expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
  });
  it("does not infer configuration authority from hiring/job title or substitute setup assignment", () => {
    const o = valid(); o.state.configurationAuthority.grants = [{ permissionKey: "agents:create", scope: null }]; expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
    const assigned = valid(); assigned.state.configurationAuthority.after.desiredSkills.push(assigned.skill.key); expect(gradeIntegratorSkillEnable(assigned).passed).toBe(false);
    const changed = valid(); changed.state.configurationAuthority.after.desiredSkills.push("another-existing-skill"); expect(gradeIntegratorSkillEnable(changed).passed).toBe(false);
  });
  it("retains target scope as evidence while the real target-specific HTTP decision stays authoritative", () => {
    const o = valid(); o.state.configurationAuthority.grants = [{ permissionKey: "agents:configure", scope: { agentIds: ["morgan"] } }];
    expect(gradeIntegratorSkillEnable(o).passed).toBe(true);
    o.state.configurationAuthority.status = 403; expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
  });
  it("requires the actual immutable revision and rejects installation or policy substitution", () => {
    const o = valid(); o.skill.markdown = "Replacement instructions"; expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
    const version = valid(); version.assignment.desiredSkillEntries[0]!.versionId = "wrong"; expect(gradeIntegratorSkillEnable(version).passed).toBe(false);
    const policy = valid(); policy.activity.push({ ...policy.activity[0]!, id: "policy-write", action: "skill_policy.updated" }); expect(gradeIntegratorSkillEnable(policy).passed).toBe(false);
  });
  it("fails closed on missing no-op snapshots and a board-backed status alone", () => {
    const o = valid(); Object.assign(o.state, { configurationAuthority: undefined }); expect(gradeIntegratorSkillEnable(o).passed).toBe(false);
    expect(skillEnableAuthorityReady(undefined, "company", "ceo", "morgan", "skill")).toBe(false);
  });
});
