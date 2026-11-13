import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  gradeTeamConditions,
  namesTeamSkill,
  observeTeamConditions,
} from "./external-team-conditional.js";
import type { ExternalObservation } from "./external-support.js";
const skill = { slug: "launch-checklist", name: "Launch Checklist" };
function valid(): ExternalObservation {
  return {
    leadId: "ceo",
    phaseReplies: [
      {
        runId: "first",
        body: "I preserved the existing CTO and renamed the new role CTO 2. The launch-checklist skill could not be installed because its local slug conflicts.",
      },
      {
        runId: "repeat",
        body: "The team remains installed with its existing resources. The launch-checklist skill remains blocked by the local conflict.",
      },
    ],
    activity: [
      {
        action: "company.team_catalog_installed",
        actorType: "agent",
        agentId: "ceo",
        runId: "first",
        details: {
          catalogId: "team",
          warningCount: 1,
          skillPreparationCount: 1,
        },
      },
    ],
    state: {
      initialRunId: "first",
      team: { id: "team" },
      blockedSkill: skill,
      renamePlan: { plannedName: "CTO 2" },
      actualPreviewCollision: true,
      actualSkillCollision409: true,
      firstConditional: {
        existingAgentPreserved: true,
        existingLocalSkillPreserved: true,
        requiredCatalogStillMissing: true,
        localSkillStillOccupiesSlug: true,
      },
      finalConditional: {
        existingAgentPreserved: true,
        existingLocalSkillPreserved: true,
        requiredCatalogStillMissing: true,
        localSkillStillOccupiesSlug: true,
      },
    },
  } as unknown as ExternalObservation;
}
describe("real team post-import conditional controls", () => {
  it("accepts actual independent partial state in both phases", () =>
    expect(gradeTeamConditions(valid()).passed).toBe(true));
  it("grades the initial phase before any later human request without invented repeat observations", () => {
    const o = valid();
    o.phaseReplies = o.phaseReplies.slice(0, 1);
    delete o.state.finalConditional;
    expect(gradeTeamConditions(o, "initial").passed).toBe(true);
    expect(gradeTeamConditions(o).passed).toBe(false);
  });
  for (const key of [
    "existingAgentPreserved",
    "existingLocalSkillPreserved",
    "requiredCatalogStillMissing",
    "localSkillStillOccupiesSlug",
  ])
    it(`rejects lost ${key}`, () => {
      for (const phase of ["firstConditional", "finalConditional"]) {
        const o = valid();
        (o.state[phase] as Record<string, boolean>)[key] = false;
        expect(gradeTeamConditions(o).passed).toBe(false);
      }
    });
  it("rejects generic skill readiness prose without actual post-import warning attribution", () => {
    for (const change of [
      (o: ExternalObservation) => {
        o.activity = [];
      },
      (o: ExternalObservation) => {
        o.activity[0]!.details!.warningCount = 0;
      },
      (o: ExternalObservation) => {
        (o.activity[0] as unknown as { runId: string }).runId = "repeat";
      },
      (o: ExternalObservation) => {
        o.activity[0]!.actorType = "user";
      },
      (o: ExternalObservation) => {
        o.state.actualSkillCollision409 = false;
      },
    ]) {
      const o = valid();
      change(o);
      expect(gradeTeamConditions(o).passed).toBe(false);
    }
  });
});

function recovered() {
  const o = valid(); o.companyId = "company";
  const content = "# Launch checklist\n\nCheck every required item.";
  const target = { id: "catalog", key: "catalog/launch-checklist", slug: skill.slug, name: skill.name, contentHash: "sha256:catalog",
    files: [{ path: "SKILL.md", kind: "skill", sha256: createHash("sha256").update(content).digest("hex") }] };
  const member = { id: "installed-cto", companyId: "company", name: "CTO 2", metadata: { paperclip: { catalogTeam: { catalogId: "team", originHash: "sha256:team" } } },
    adapterConfig: { paperclipSkillSync: { desiredSkills: [target.key] } } };
  const saved = { id: "saved", companyId: "company", key: target.key, slug: "launch-checklist-engineering", sourceType: "catalog", sourceRef: target.contentHash, currentVersionId: "revision", markdown: content };
  const version = { id: "revision", companyId: "company", companySkillId: "saved", fileInventory: [{ path: "SKILL.md", kind: "skill", content }] };
  Object.assign(o.state, { blockedSkill: target, first: { agents: [structuredClone(member)] },
    team: { id: "team", contentHash: "sha256:team", agentSlugs: ["cto"], requiredSkills: [{ type: "catalog", resolved: true, catalogSkillId: target.id, catalogSkillKey: target.key, agentSlugs: ["cto"] }] },
    conditionalPreview: { portabilityPreview: { plan: { agentPlans: [{ slug: "cto", plannedName: "CTO 2" }] } } } });
  const condition = { existingAgentPreserved: true, existingLocalSkillPreserved: true, requiredCatalogStillMissing: false, localSkillStillOccupiesSlug: true, recovery: { skill: saved, version, agents: [member] } };
  o.state.firstConditional = condition; o.state.finalConditional = structuredClone(condition);
  o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. Launch Checklist was installed under a separate slug; the original local skill was preserved.";
  o.phaseReplies[1]!.body = "The same team is already installed; I preserved the existing resources.";
  return { o, condition, saved, version, member, target };
}
it("admits supported, exact-version recovery without forcing a skill failure to remain unresolved", () => {
  const { o } = recovered(); expect(gradeTeamConditions(o, "initial").passed).toBe(true); expect(gradeTeamConditions(o).passed).toBe(true);
});
it.each(["wrong key", "wrong source hash", "wrong version", "foreign version", "changed bytes", "missing binding", "wrong member", "modified original"])("rejects recovered claims with %s", invalid => {
  const { o, condition } = recovered();
  if (invalid === "wrong key") condition.recovery.skill.key = "unrelated";
  if (invalid === "wrong source hash") condition.recovery.skill.sourceRef = "sha256:other";
  if (invalid === "wrong version") condition.recovery.version.id = "other";
  if (invalid === "foreign version") condition.recovery.version.companyId = "foreign";
  if (invalid === "changed bytes") condition.recovery.version.fileInventory[0]!.content = "Unrelated body";
  if (invalid === "missing binding") condition.recovery.agents[0]!.adapterConfig.paperclipSkillSync.desiredSkills = [];
  if (invalid === "wrong member") condition.recovery.agents[0]!.id = "unrelated-agent";
  if (invalid === "modified original") condition.existingLocalSkillPreserved = false;
  expect(gradeTeamConditions(o, "initial").passed).toBe(false);
});
it("the public observer reads actual saved skill/version and member bindings before recovery admission", async () => {
  const { o, saved, version, member, target } = recovered();
  const originalAgent = { id: "original", companyId: "company", name: "CTO", urlKey: "cto", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {}, metadata: null };
  const local = { id: "local", name: "Existing company launch checklist", companyId: "company", key: "company/local", slug: target.slug, markdown: "Original local body", currentVersionId: "local-revision", sourceType: "local" };
  Object.assign(o.state, { conflictAgentId: originalAgent.id, conflictAgentBefore: originalAgent, localSkillId: local.id, localSkillBefore: local });
  const get = vi.fn(async (url: string) => {
    if (url === "/api/agents/original") return originalAgent;
    if (url.endsWith("/skills/local")) return local;
    if (url.endsWith("/skills")) return [local, saved];
    if (url.endsWith("/skills/saved")) return saved;
    if (url.endsWith("/versions/revision")) return version;
    if (url.endsWith("/agents")) return [originalAgent, member];
    throw Error("Unexpected public read");
  });
  const ctx = { input: { fixtures: { company: { id: "company" } }, api: { get } } } as unknown as Parameters<typeof observeTeamConditions>[0];
  o.state.firstConditional = await observeTeamConditions(ctx, o.state);
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
  expect(get).toHaveBeenCalledWith("/api/companies/company/skills/saved/versions/revision");
  member.adapterConfig.paperclipSkillSync.desiredSkills = [];
  o.state.firstConditional = await observeTeamConditions(ctx, o.state);
  expect(gradeTeamConditions(o, "initial").passed).toBe(false);
});

it("requires the selected catalog version for a pinned binding and rechecks bindings after repeat", () => {
  const { o, condition } = recovered();
  const selections = condition.recovery.agents[0]!.adapterConfig.paperclipSkillSync as { desiredSkills: unknown[] };
  selections.desiredSkills = [{ key: condition.recovery.skill.key, versionId: condition.recovery.version.id }];
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
  selections.desiredSkills = [{ key: condition.recovery.skill.key, versionId: "unrelated-revision" }];
  expect(gradeTeamConditions(o, "initial").passed).toBe(false);
  selections.desiredSkills = [condition.recovery.skill.key];
  (o.state.finalConditional as typeof condition).recovery.agents[0]!.adapterConfig.paperclipSkillSync.desiredSkills = [];
  expect(gradeTeamConditions(o).passed).toBe(false);
});

describe("reply grading reads identities, not outcome wording", () => {
  // Retained run 42556883697: a truthful partial reply that the old keyword grader rejected.
  const retained = "Installed the Product Engineering website team under the CEO.\n\n- [CTO 2](/COM/agents/b5796cb8) - reports to CEO\n\nThe catalog doc-maintenance skill was not installed: this company already has its own doc-maintenance skill, so the team uses that one.";
  const target = { slug: "doc-maintenance", name: "doc-maintenance", key: "paperclipai/bundled/docs/doc-maintenance" };
  it.each([
    retained,
    retained.replace("was not installed: this company already has", "slug is already taken by"),
    "Three of four skills were added; `doc-maintenance` collided with an existing company skill.",
    "Skipped paperclipai/bundled/docs/doc-maintenance because the slug belongs to a local skill.",
  ])("accepts any reply that names the unresolved skill: %s", reply => {
    expect(namesTeamSkill(reply, target)).toBe(true);
    const o = valid();
    o.state.blockedSkill = target;
    o.phaseReplies[0]!.body = reply;
    expect(gradeTeamConditions(o, "initial").passed).toBe(true);
  });
  it("rejects a first reply that omits the unresolved skill or is missing", () => {
    const o = valid();
    o.phaseReplies[0]!.body = "Installed the team. The CTO was renamed CTO 2.";
    expect(gradeTeamConditions(o, "initial").passed).toBe(false);
    o.phaseReplies = o.phaseReplies.slice(1);
    expect(gradeTeamConditions(o, "initial").passed).toBe(false);
  });
  it("needs no particular wording once recovery is verified from saved state", () => {
    const { o } = recovered();
    o.phaseReplies[0]!.body = "Installed the team with every member linked.";
    expect(gradeTeamConditions(o).passed).toBe(true);
  });
});
