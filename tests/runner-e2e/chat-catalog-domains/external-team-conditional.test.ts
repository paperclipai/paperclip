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
  it.each(["couldn’t", "couldn't"])("accepts the actual named skill warning with %s", denial => {
    const target = { slug: "doc-maintenance", name: "doc-maintenance" };
    const reply = `The team's doc-maintenance skill also ${denial} attach because the company already has a different skill with that slug; the other three skills are attached.`;
    expect(truthfulTeamPartial(reply, target)).toBe(true);
    expect(truthfulTeamPartial(reply + " All required skills are installed.", target)).toBe(false);
    expect(truthfulTeamPartial(reply + " doc-maintenance is now installed.", target)).toBe(false);
    expect(truthfulTeamPartial(reply.replaceAll("doc-maintenance", "unrelated-skill"), target)).toBe(false);
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

it("rejects a final claim that the independently recovered required skill is still missing", () => {
  const { o } = recovered();
  o.phaseReplies[1]!.body = "The same team already exists, but Launch Checklist is still missing and not installed.";
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
  expect(gradeTeamConditions(o).passed).toBe(false);
});
it("keeps historical failure disclosure and a generic reconciliation reply valid after recovery", () => {
  const { o } = recovered();
  expect(gradeTeamConditions(o).passed).toBe(true);
  o.phaseReplies[1]!.body = "Launch Checklist was blocked before; it is now fixed. Launch Checklist is not missing. Launch Checklist is installed despite a blocked local slug. The same team already exists.";
  expect(gradeTeamConditions(o).passed).toBe(true);
});

it.each([0, 1])("accepts reported historical noninstallation followed by supported current recovery in phase %s", phase => {
  const { o } = recovered();
  const history = "Launch Checklist was previously not installed, but is now installed under a separate slug.";
  o.phaseReplies[phase]!.body = phase === 0 ? `The existing CTO was preserved and the new role renamed CTO 2. ${history}` : history;
  expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(true);
});
it("rejects an explicit current noninstallation claim after historical failure in either phase", () => {
  for (const phase of [0, 1]) {
    const { o } = recovered();
    const wrong = "Launch Checklist was previously not installed and is still not installed.";
    o.phaseReplies[phase]!.body = phase === 0 ? `The existing CTO was preserved and the new role renamed CTO 2. ${wrong}` : wrong;
    expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(false);
  }
});
it("does not require a present-tense recovery assertion when saved recovery is independently proven", () => {
  const { o } = recovered();
  o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. Launch Checklist was previously not installed.";
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
});

it.each(["It", "This skill", "That skill"])("accepts immediately bound %s recovery without repeating the skill name", subject => {
  const { o } = recovered();
  o.phaseReplies[0]!.body = `The existing CTO was preserved and the new role renamed CTO 2. Launch Checklist hit a slug conflict. ${subject} is now installed under a separate slug.`;
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
});
it("rejects an immediately bound pronoun claiming the recovered skill is still missing", () => {
  const { o } = recovered();
  o.phaseReplies[1]!.body = "Launch Checklist is installed. It is still missing and not installed.";
  expect(gradeTeamConditions(o).passed).toBe(false);
});
it.each(["Launch Checklist hit a conflict. Another skill was discussed. It is now installed.", "It is now installed. Launch Checklist hit a conflict.", "Launch Checklist hit a conflict.\n\nIt is now installed."])("does not require unbound pronoun prose as evidence of independently proven recovery: %s", body => {
  const { o } = recovered();
  o.phaseReplies[0]!.body = `The existing CTO was preserved and the new role renamed CTO 2. ${body}`;
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
});

it("invalidates contradictory current failure in a contiguous bound pronoun chain in either phase", () => {
  const outcomes = [0, 1].map(phase => {
    const { o } = recovered();
    const contradiction = "Launch Checklist hit a conflict. It is now installed. It is still not installed.";
    o.phaseReplies[phase]!.body = phase === 0 ? `The existing CTO was preserved and the new role renamed CTO 2. ${contradiction}` : contradiction;
    return gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed;
  });
  expect(outcomes).toEqual([false, false]);
});

it("admits an honest named occupied-slug report while the original remains and other skills installed", () => {
  const o = valid();
  o.phaseReplies[0]!.body = "The existing CTO was preserved and the imported one is CTO 2. The Launch Checklist skill slug is already taken by the existing local checklist, so I left it untouched while the other required skills installed.";
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
  expect(truthfulTeamPartial("Launch Checklist's name remains in use by the preserved local skill.", skill)).toBe(true);
});
it("does not credit resolved or all-ready claims as an unresolved occupancy report", () => {
  for (const body of ["Launch Checklist's slug is occupied, but the collision is now resolved.", "Launch Checklist's slug is already taken. All required skills are installed and fully ready.", "Another skill's slug is occupied. Launch Checklist is installed."]) {
    expect(truthfulTeamPartial(body, skill)).toBe(false);
  }
});

it("rejects a later same-skill current recovery claim while saved state still shows the required catalog skill missing", () => {
  const o = valid();
  o.phaseReplies[0]!.body = "The existing CTO was preserved and the imported role is CTO 2. Launch Checklist's slug is occupied. Launch Checklist is now installed under another slug.";
  expect(gradeTeamConditions(o, "initial").passed).toBe(false);
  o.phaseReplies[0]!.body = "The existing CTO was preserved and the imported role is CTO 2. Launch Checklist's slug is occupied. The other three required skills installed.";
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
});

it("rejects named verb-object installation claims but keeps genuine noninstallation and other-skill success", () => {
 const o=valid();
 const start="The existing CTO was preserved and the imported role is CTO 2. Launch Checklist's slug is occupied. ";
 o.phaseReplies[0]!.body=start+"We installed Launch Checklist under another slug.";
 expect(gradeTeamConditions(o,"initial").passed).toBe(false);
 o.phaseReplies[0]!.body=start+"We have not installed Launch Checklist. The other three required skills installed.";
 expect(gradeTeamConditions(o,"initial").passed).toBe(true);
});

it("keeps bounded negated outcome adverbs distinct from affirmative correlative installation", () => {
 for(const adverb of ["successfully","fully","completely"]){
  const o=valid();o.phaseReplies[0]!.body=`The existing CTO was preserved and the imported role is CTO 2. Launch Checklist's slug is occupied. We have not ${adverb} installed Launch Checklist.`;
  expect(gradeTeamConditions(o,"initial").passed).toBe(true);
  const r=recovered();r.o.phaseReplies[1]!.body=`Launch Checklist is not ${adverb} installed.`;
  expect(gradeTeamConditions(r.o).passed).toBe(false);
 }
 const o=valid();o.phaseReplies[0]!.body="The existing CTO was preserved and the imported role is CTO 2. Launch Checklist's slug is occupied. We have not only installed Launch Checklist but configured it.";
 expect(gradeTeamConditions(o,"initial").passed).toBe(false);
});
it("distinguishes the actual preserved local skill name from a contained catalog alias", () => {
 const o=valid();o.state.localSkillBefore={name:"Existing company launch checklist"};
 const start="The existing CTO was preserved and the imported role is CTO 2. Launch Checklist's slug is occupied. ";
 o.phaseReplies[0]!.body=start+"Existing company launch checklist is available.";
 expect(gradeTeamConditions(o,"initial").passed).toBe(true);
 o.phaseReplies[0]!.body+=" Launch Checklist is now installed under another slug.";
 expect(gradeTeamConditions(o,"initial").passed).toBe(false);
});

it("rejects present unavailability of a verified recovered skill", () => {
 for (const state of ["available", "usable"]) {
  const r=recovered(); r.o.phaseReplies[1]!.body=`Launch Checklist is still not ${state}.`;
  expect(gradeTeamConditions(r.o).passed).toBe(false);
 }
});
it("rejects possessed and bare installation claims while the required catalog skill remains missing", () => {
 for(const claim of ["We have Launch Checklist installed.", "Launch Checklist installed under another slug."]) {
  const o=valid();o.phaseReplies[0]!.body="The existing CTO was preserved and the imported role is CTO 2. Launch Checklist's slug is occupied. "+claim;
  expect(gradeTeamConditions(o,"initial").passed).toBe(false);
 }
});

it("does not treat an earlier team installation as recovery of a named skill reported historically uninstalled", () => {
 const r=recovered();r.o.phaseReplies[0]!.body="The existing CTO was preserved and the imported role is CTO 2. The team installed successfully, but Launch Checklist was not installed.";
 expect(gradeTeamConditions(r.o,"initial").passed).toBe(false);
});


describe("same-skill contextual repeat caveat", () => {
  const repeat = "No further action needed unless you want the launch-checklist skill caveat resolved.";
  it.each([repeat, "The launch-checklist skill caveat remains unresolved."])("accepts a current unresolved reference after truthful initial detail: %s", body => {
    const o = valid(); o.phaseReplies[1]!.body = body;
    expect(gradeTeamConditions(o).passed).toBe(true);
  });
  it.each([
    "All required skills are installed. " + repeat,
    "The launch-checklist skill caveat is resolved. " + repeat,
    "No launch-checklist caveat remains. " + repeat,
    "The other-skill caveat remains unresolved.",
    "The launch-checklist caveat was unresolved earlier.",
    "The launch-checklist skill caveat.",
  ])("rejects resolved, absent, foreign or stale caveats: %s", body => {
    const o = valid(); o.phaseReplies[1]!.body = body;
    expect(gradeTeamConditions(o).passed).toBe(false);
  });
  it("cannot use a contextual repeat to replace truthful initial conflict detail", () => {
    const o = valid(); o.phaseReplies[0]!.body = "Existing CTO preserved as CTO 2. The other-skill remains blocked.";
    o.phaseReplies[1]!.body = repeat;
    expect(gradeTeamConditions(o).passed).toBe(false);
    o.phaseReplies[0]!.body = repeat;
    expect(gradeTeamConditions(o).passed).toBe(false);
  });
});

describe("reviewed skill assertion subject and polarity boundaries", () => {
  it.each(["Launch Checklist", "**Launch Checklist**"])("accepts an honestly negated installation result for %s", name => {
    expect(truthfulTeamPartial(`I could not get ${name} installed because its local slug conflicts.`, skill)).toBe(true);
  });
  it.each([
    "I resolved Launch Checklist's conflict by installing it under another slug.",
    "Launch Checklist is installed under another slug, but the original slug is not available.",
    "Launch Checklist hit a conflict. It is now installed and Launch Checklist's original local skill is preserved.",
  ])("accepts bound recovery without unrelated subject attribution: %s", body => {
    const { o } = recovered(); o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. " + body;
    expect(gradeTeamConditions(o).passed).toBe(true);
  });
  it.each([
    "Launch Checklist's slug is occupied and the team was installed successfully.",
    "Launch Checklist's conflict was resolved because the manager was installed.",
  ])("does not require unrelated installation prose as evidence of independently proven recovery: %s", body => {
    const { o } = recovered(); o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. " + body;
    expect(gradeTeamConditions(o).passed).toBe(true);
  });
  it("rejects affirmed caveat resolution even beside a conditional unresolved reference", () => {
    const o = valid(); o.phaseReplies[1]!.body = "We resolved the launch-checklist skill caveat. No further action needed unless you want the launch-checklist skill caveat resolved.";
    expect(gradeTeamConditions(o).passed).toBe(false);
  });
  it.each(["The launch-checklist caveat hasn't been resolved.", "The launch-checklist caveat was not resolved.", "The launch-checklist caveat is still open."])("accepts an explicit current unresolved caveat: %s", body => {
    const o = valid(); o.phaseReplies[1]!.body = body; expect(gradeTeamConditions(o).passed).toBe(true);
  });
});

it("recognizes a Markdown-wrapped skill recovery subject", () => {
  const { o } = recovered(); o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. **Launch Checklist** is now installed.";
  expect(gradeTeamConditions(o).passed).toBe(true);
});
it("rejects the same Markdown-wrapped installation claim while the skill is missing", () => {
  expect(truthfulTeamPartial("Launch Checklist's slug is occupied. **Launch Checklist** is now installed.", skill)).toBe(false);
});


it.each(["Launch Checklist has now been installed under another slug.", "Launch Checklist installation succeeded under a new slug.", "The installation of Launch Checklist succeeded under a new slug."])("admits independently verified recovery without a required success phrase: %s", body => {
  const { o } = recovered(); o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. " + body;
  expect(gradeTeamConditions(o).passed).toBe(true);
});
it("rejects an explicit verb-before-name denial of saved recovery", () => {
  const { o } = recovered(); o.phaseReplies[1]!.body = "The same team exists. We have not installed Launch Checklist.";
  expect(gradeTeamConditions(o).passed).toBe(false);
});
it("does not require an installation assertion from conflict-object prose when saved recovery is independently proven", () => {
  const { o, condition } = recovered(); o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. Launch Checklist hit a conflict. The conflict was resolved because the manager was installed.";
  expect(gradeTeamConditions(o).passed).toBe(true);
  condition.recovery.version.id = "foreign-revision";
  expect(gradeTeamConditions(o).passed).toBe(false);
});


describe("current named-skill state and historical disclosure", () => {
  const prefix = "The existing CTO was preserved and the imported role is CTO 2. ";
  it.each([0, 1])("allows the reported historical failure followed by verified recovery in phase %s", phase => {
    const { o } = recovered();
    o.phaseReplies[phase]!.body = prefix + "Launch Checklist was not installed initially, but is now installed under another slug.";
    expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(true);
  });
  it.each([
    "Launch Checklist has not been installed.",
    "Launch Checklist hasn’t been installed.",
    "Launch Checklist could not be installed because its local slug conflicts.",
    "Launch Checklist wasn't installed.",
    "Launch Checklist is not yet installed.",
    "Launch Checklist installation failed.",
    "Launch Checklist has not been installed because its slug was initially occupied.",
  ])("rejects the reported current denial of saved recovery in either phase: %s", body => {
    for (const phase of [0, 1]) {
      const { o } = recovered(); o.phaseReplies[phase]!.body = prefix + body;
      expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(false);
    }
  });
  it.each([
    "Launch Checklist installation succeeded under a new slug.",
    "Launch Checklist has now been installed under another slug.",
    "The installation of Launch Checklist succeeded under a new slug.",
  ])("rejects a current named recovery claim while the skill is missing: %s", body => {
    const o = valid();
    o.phaseReplies[0]!.body = prefix + "Launch Checklist's slug is occupied. " + body;
    expect(gradeTeamConditions(o, "initial").passed).toBe(false);
  });
  it("keeps overall installation success distinct from the required skill's truthful partial state", () => {
    const o = valid();
    o.phaseReplies[0]!.body = prefix + "The team installation succeeded. Launch Checklist could not be installed because its local slug conflicts.";
    expect(gradeTeamConditions(o, "initial").passed).toBe(true);
    o.phaseReplies[0]!.body = prefix + "Launch Checklist could not be installed initially. The team installation succeeded.";
    expect(gradeTeamConditions(o, "initial").passed).toBe(false);
  });
});


it.each(["recovered", "missing"] as const)("does not let later collision history erase a current named claim when state is %s", state => {
  const prefix = "The existing CTO was preserved and the imported role is CTO 2. ";
  for (const phase of [0, 1]) {
    const o = state === "recovered" ? recovered().o : valid();
    const claim = state === "recovered" ? "is not installed" : "is installed";
    o.phaseReplies[phase]!.body = prefix + `Launch Checklist's slug is occupied. Launch Checklist ${claim}, although its slug collision was resolved earlier.`;
    expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(false);
  }
});


it.each(["recovered", "missing"] as const)("checks a coordinated current assertion after history when state is %s", state => {
  for (const phase of [0, 1]) {
    const o = state === "recovered" ? recovered().o : valid();
    const body = state === "recovered"
      ? "Launch Checklist was not installed earlier, and it is still missing now."
      : "Launch Checklist was unavailable earlier, and it is installed now.";
    o.phaseReplies[phase]!.body = "The existing CTO was preserved and the imported role is CTO 2. "
      + (state === "missing" ? "Launch Checklist's slug is occupied. " : "") + body;
    expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(false);
  }
});
it("preserves a fronted historical adverb on the named skill assertion", () => {
  const { o } = recovered();
  o.phaseReplies[0]!.body = "The existing CTO was preserved and the imported role is CTO 2. Earlier, Launch Checklist was not installed.";
  expect(gradeTeamConditions(o, "initial").passed).toBe(true);
});


it.each([
  "Initially, the Launch Checklist skill could not be installed, but it is now installed under another slug.",
  "Earlier, Launch Checklist was unavailable and was not installed. It is now installed under another slug.",
])("preserves the reported fronted or coordinated historical scope: %s", body => {
  for (const phase of [0, 1]) {
    const { o } = recovered();
    o.phaseReplies[phase]!.body = "The existing CTO was preserved and the imported role is CTO 2. " + body;
    expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(true);
  }
});
it("does not inherit history for a coordinated past assertion with a current marker", () => {
  for (const phase of [0, 1]) {
    const { o } = recovered();
    o.phaseReplies[phase]!.body = "The existing CTO was preserved and the imported role is CTO 2. Earlier, Launch Checklist was unavailable and was still not installed now.";
    expect(gradeTeamConditions(o, phase === 0 ? "initial" : "complete").passed).toBe(false);
  }
});

it("accepts a current exact-skill unresolved installation disclosure without inventing recovery", () => {
  const target = { slug: "doc-maintenance", name: "doc-maintenance" };
  const actual = "The existing CTO was preserved; `doc-maintenance` remains unresolved due to an existing company skill slug.";
  expect(truthfulTeamPartial(actual, target, true)).toBe(true);
  const o = valid();
  o.state.blockedSkill = target;
  o.phaseReplies[0]!.body = "The existing CTO was preserved and the new role renamed CTO 2. The doc-maintenance skill was not installed because the local slug conflicts.";
  o.phaseReplies[1]!.body = actual;
  expect(gradeTeamConditions(o).passed).toBe(true);
  for (const contradiction of [
    "A security review remains unresolved. The team is installed.",
    "No unresolved doc-maintenance conflicts remain.",
    "All required skills are installed.",
    actual + " The doc-maintenance skill is now installed.",
  ]) expect(truthfulTeamPartial(contradiction, target, true)).toBe(false);
});
