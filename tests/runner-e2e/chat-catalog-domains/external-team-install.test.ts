import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import { CHAT_OPENCODE_MODEL } from "../chat-runtime-profile.js";
import { updateAgentPermissionsSchema } from "../../../packages/shared/src/validators/agent.js";
import { catalogTeamInstallSchema } from "../../../packages/shared/src/validators/teams-catalog.js";
import { describe, expect, it, vi } from "vitest";
import { teamInstallExternalCases, selectedTeamInstallRuntime, teamInstallOverrides, verifyInstalledTeamRuntime } from "./external-team-install.js";
function valid() {
  const team = {
    id: "team",
    contentHash: "hash",
    agentSlugs: ["cto", "coder"],
    counts: { agents: 2, projects: 1, routines: 1 },
  };
  const agent = (id: string) => ({
    id,
    companyId: "company",
    adapterType: "paperclip_runner",
    adapterConfig: { provider: "opencode", model: CHAT_OPENCODE_MODEL, timeoutSec: 0, env: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "account", version: "latest" } } },
    urlKey: id,
    metadata: {
      paperclip: { catalogTeam: { catalogId: "team", originHash: "hash" } },
    },
  });
  const before = { agents: [], projects: [], routines: [], installed: [] };
  const after = {
    agents: [agent("cto"), agent("coder")],
    projects: [{ id: "project", companyId: "company", urlKey: "website" }],
    routines: [{ id: "routine", companyId: "company" }],
    installed: [{ catalogId: "team", agentCount: 2, outOfDate: false }],
  };
  return {
    scenarioId: "teams.install-team",
    origin: "http://fixture.invalid",
    companyId: "company",
    leadId: "ceo",
    phaseReplies: [
      {
        runId: "initial",
        body: "The existing CTO name conflicted, so the team got CTO 2. Team resources were installed, but launch-checklist skill could not be installed because its slug conflicts with the local checklist.",
      },
      {
        runId: "repeat",
        body: "The existing team is already installed; I kept its same resources. The launch-checklist skill is still blocked by the local slug conflict.",
      },
    ],
    connections: [],
    profiles: [],
    secrets: [],
    endpoints: [],
    interactions: [],
    tasks: [],
    projects: after.projects,
    goals: [],
    comments: [],
    documents: [],
    revisions: [],
    humanQueries: [],
    reply: "Installed the team; it already exists.",
    links: [
      "/ACORN/agents/cto",
      "/ACORN/agents/coder",
      "/ACORN/projects/website",
    ],
    runs: [
      { id: "initial", status: "succeeded" },
      { id: "repeat", status: "succeeded" },
    ],
    activity: [
      {
        id: "install",
        action: "company.team_catalog_installed",
        actorType: "agent",
        agentId: "ceo",
        runId: "initial",
        details: {
          catalogId: "team",
          warningCount: 1,
          skillPreparationCount: 1,
        },
      },
    ],
    state: {
      blockedSkill: {
        id: "required",
        key: "catalog-required",
        slug: "launch-checklist",
        name: "Launch Checklist",
      },
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
      team,
      selectedRuntime: { profileId: "runner-opencode", adapterType: "paperclip_runner", provider: "opencode", model: CHAT_OPENCODE_MODEL, accountRef: { type: "secret_ref", secretId: "account", version: "latest" } },
      runtimeReadback: { memberIds: ["coder", "cto"], provider: "opencode", model: CHAT_OPENCODE_MODEL, verifiedBeforeImportedWork: true },
      before,
      first: structuredClone(after),
      after,
      companyPrefix: "ACORN",
      previewAccepted: true,
      previewErrorCount: 0,
      actorCanCreateAgents: true,
      existingAccountReady: true,
      originalHumanQuery: "Install that website team in this company.",
      repeatHumanQuery: "Install that website team in this company.",
      initialRunId: "initial",
    },
  };
}
describe("real catalog installer oracle", () => {
  const definition = teamInstallExternalCases[0]!;
  it("accepts attributed installation and actual repeat reconciliation", () => {
    expect(definition.grade(valid()).passed).toBe(true);
  });
  it("rejects plausible duplicate installations, wrong provenance, human prepopulation and substituted repeat transcript", () => {
    for (const change of [
      (o: ReturnType<typeof valid>) => {
        o.state.after.agents.push({ ...o.state.after.agents[0]!, id: "copy" });
      },
      (o: ReturnType<typeof valid>) => {
        o.state.after.agents[0]!.metadata.paperclip.catalogTeam.originHash =
          "other-package";
      },
      (o: ReturnType<typeof valid>) => {
        o.activity[0]!.actorType = "user";
      },
      (o: ReturnType<typeof valid>) => {
        o.phaseReplies[1]!.runId = "initial";
      },
      (o: ReturnType<typeof valid>) => {
        o.links[2] = "https://other.invalid/ACORN/projects/project";
      },
      (o: ReturnType<typeof valid>) => {
        o.links[2] = "/OTHER/projects/project";
      },
      (o: ReturnType<typeof valid>) => {
        o.links[2] = "/ACORN/projects";
      },
    ]) {
      const o = valid();
      change(o);
      expect(definition.grade(o).passed).toBe(false);
    }
  });
  it("missing evidence or a successful-sounding reply alone cannot pass", () => {
    expect(definition.grade(undefined).passed).toBe(false);
    expect(definition.grade({ reply: "Installed everything." }).passed).toBe(
      false,
    );
  });
});

function runtimeFixture() {
  const o = valid();
  const ctx = { input: { execution: { profile: { id: "runner-opencode", provider: "opencode", model: CHAT_OPENCODE_MODEL, credential: "OPENROUTER_API_KEY" } }, fixtures: { company: { id: "company" }, secretRefs: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "account", version: "latest" } } } } } as unknown as ChatCatalogContext;
  const actor = { ...o.state.after.agents[0]!, id: "ceo", adapterConfig: { ...o.state.after.agents[0]!.adapterConfig, cwd: "/not-a-team-cwd", instructionsFilePath: "/not-a-team-instruction", env: { ...o.state.after.agents[0]!.adapterConfig.env, UNRELATED_VALUE: "must-not-copy" } } } as unknown as Agent;
  return { o, ctx, actor };
}
it("the actual public per-slug override schema accepts only the selected runtime/account configuration, not CEO instructions or cwd", () => {
  const f = runtimeFixture(), runtime = selectedTeamInstallRuntime(f.ctx, f.actor), overrides = teamInstallOverrides(f.o.state.team as never, runtime);
  const payload = catalogTeamInstallSchema.parse({ targetManagerAgentId: "ceo", adapterOverrides: overrides });
  expect(Object.keys(payload.adapterOverrides!)).toEqual(["cto", "coder"]);
  for (const entry of Object.values(payload.adapterOverrides!)) {
    expect(entry).toEqual({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: CHAT_OPENCODE_MODEL, timeoutSec: 0, lifecycleMode: "per_turn", opencodePermissionMode: "allow", env: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "account", version: "latest" } } } });
  }
  expect(JSON.stringify(payload)).not.toContain("must-not-copy"); expect(JSON.stringify(payload)).not.toContain("not-a-team");
});
it.each(["provider", "model", "account", "plaintext", "company"])("rejects a wrong selected %s before exposing installer context", invalid => {
  const f = runtimeFixture();
  if (invalid === "provider") f.actor.adapterConfig.provider = "codex";
  if (invalid === "model") f.actor.adapterConfig.model = "openrouter/other/model";
  if (invalid === "account") (f.actor.adapterConfig.env as Record<string, unknown>).OPENROUTER_API_KEY = { type: "secret_ref", secretId: "foreign", version: "latest" };
  if (invalid === "plaintext") (f.actor.adapterConfig.env as Record<string, unknown>).OPENROUTER_API_KEY = "must-not-copy";
  if (invalid === "company") f.actor.companyId = "foreign";
  expect(() => selectedTeamInstallRuntime(f.ctx, f.actor)).toThrow("actual configured");
});
it("independently reads every actual member before another human request or imported native work", async () => {
  const f = runtimeFixture(), seen: string[] = [];
  Object.assign(f.ctx.input, { api: { get: async (route: string) => { seen.push(route); return f.o.state.after.agents.find(agent => route.endsWith(agent.id)); } } });
  Object.assign(f.ctx, { allRuns: async () => [{ id: "source", agentId: "ceo", status: "succeeded", startedAt: "2026-10-28T01:00:00Z" }] });
  const proof = await verifyInstalledTeamRuntime(f.ctx, f.o.state.team as never, f.o.state.first as never, selectedTeamInstallRuntime(f.ctx, f.actor));
  expect(seen).toEqual(["/api/agents/cto", "/api/agents/coder"]); expect(proof).toMatchObject({ memberIds: ["coder", "cto"], verifiedBeforeImportedWork: true, model: CHAT_OPENCODE_MODEL });
});
it.each(["model", "account", "wrong returned identity", "already started"])("fails actual member runtime readback for %s", async invalid => {
  const f = runtimeFixture();
  const saved = structuredClone(f.o.state.after.agents);
  if (invalid === "model") saved[0]!.adapterConfig.model = "openrouter/other/model";
  if (invalid === "account") saved[0]!.adapterConfig.env.OPENROUTER_API_KEY.secretId = "foreign";
  if (invalid === "wrong returned identity") saved[0]!.id = "other";
  Object.assign(f.ctx.input, { api: { get: async (route: string) => saved[route.endsWith("cto") ? 0 : 1] } });
  Object.assign(f.ctx, { allRuns: async () => invalid === "already started" ? [{ id: "work", agentId: "cto", status: "running", startedAt: "2026-10-28T01:00:00Z" }] : [] });
  await expect(verifyInstalledTeamRuntime(f.ctx, f.o.state.team as never, f.o.state.first as never, selectedTeamInstallRuntime(f.ctx, f.actor))).rejects.toThrow();
});
it("real resource counts and actor attribution cannot conceal wrong member providers/models/accounts or missing pre-work readback", () => {
  for (const change of [
    (o: ReturnType<typeof valid>) => { o.state.after.agents[0]!.adapterConfig.provider = "codex"; },
    (o: ReturnType<typeof valid>) => { o.state.first.agents[0]!.adapterConfig.model = "openrouter/other/model"; },
    (o: ReturnType<typeof valid>) => { o.state.after.agents[0]!.adapterConfig.env.OPENROUTER_API_KEY.secretId = "foreign"; },
    (o: ReturnType<typeof valid>) => { o.state.runtimeReadback.verifiedBeforeImportedWork = false; },
    (o: ReturnType<typeof valid>) => { o.state.runtimeReadback.memberIds = ["other", "cto"]; },
    (o: ReturnType<typeof valid>) => { o.state.selectedRuntime.model = "openrouter/other/model"; o.state.after.agents.forEach(agent => { agent.adapterConfig.model = "openrouter/other/model"; }); },
  ]) { const o = valid(); change(o); expect(teamInstallExternalCases[0]!.grade(o).passed).toBe(false); }
});

it.each([true,false])("sends the complete permission schema without changing effective assignment=%s",async canAssignTasks=>{
 const actor={id:"ceo",companyId:"company",role:"ceo",access:{canAssignTasks}};
 const patch=vi.fn(async(_route:string,body:unknown)=>{expect(updateAgentPermissionsSchema.parse(body)).toEqual({canCreateAgents:true,canAssignTasks});throw new Error("stop-after-validated-permission-request");});
 const ctx={input:{fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{get:async(route:string)=>route==="/api/teams/catalog"?[{slug:"product-engineering",compatibility:"compatible"}]:actor,patch}}} as unknown as ChatCatalogContext;
 await expect(teamInstallExternalCases[0]!.setup(ctx)).rejects.toThrow("stop-after-validated-permission-request");
 expect(patch).toHaveBeenCalledOnce();
});
it.each(["foreign company","wrong agent","not CEO","missing effective assignment"])("refuses %s identity before permission mutation",async invalid=>{
 const actor={id:"ceo",companyId:"company",role:"ceo",access:{canAssignTasks:true}};
 if(invalid==="foreign company")actor.companyId="foreign";
 if(invalid==="wrong agent")actor.id="other";
 if(invalid==="not CEO")actor.role="engineer";
 if(invalid==="missing effective assignment")delete(actor as {access?:unknown}).access;
 const patch=vi.fn(); const ctx={input:{fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{get:async(route:string)=>route==="/api/teams/catalog"?[{slug:"product-engineering",compatibility:"compatible"}]:actor,patch}}} as unknown as ChatCatalogContext;
 await expect(teamInstallExternalCases[0]!.setup(ctx)).rejects.toThrow("observed installer");expect(patch).not.toHaveBeenCalled();
});
