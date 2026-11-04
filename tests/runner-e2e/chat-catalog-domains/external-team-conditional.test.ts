import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  gradeTeamConditions,
  observeTeamConditions,
  truthfulTeamPartial,
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
  it("a truthful later reply cannot rescue false complete initial installation", () => {
    const o = valid();
    o.phaseReplies[0]!.body =
      "Renamed the CTO to CTO 2. The launch-checklist skill had a conflict, but all required skills are installed and fully ready.";
    expect(gradeTeamConditions(o).passed).toBe(false);
  });
  it("accepts natural incomplete reports and rejects contradictory complete claims", () => {
    for (const text of [
      "The launch-checklist skill could not be installed due to the local name conflict. The team is not fully ready.",
      "Launch Checklist remains blocked; the agents and project were installed successfully.",
    ])
      expect(truthfulTeamPartial(text, skill)).toBe(true);
    for (const text of [
      "The team is installed.",
      "launch-checklist failed. All required skills are installed.",
      "Launch Checklist is blocked, but there are no warnings.",
    ])
      expect(truthfulTeamPartial(text, skill)).toBe(false);
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
  const local = { id: "local", companyId: "company", key: "company/local", slug: target.slug, markdown: "Original local body", currentVersionId: "local-revision", sourceType: "local" };
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
