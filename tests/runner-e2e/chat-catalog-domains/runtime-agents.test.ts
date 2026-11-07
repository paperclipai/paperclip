import type { AgentDetail } from "../../../packages/shared/src/types/agent.js";
import { describe, it, expect } from "vitest";
import { gradeRuntimeAgents, hiringDeniedPermissions, runtimeAgentsCases } from "./runtime-agents.js";
import { updateAgentPermissionsSchema } from "../../../packages/shared/src/validators/agent.js";
import { createHash } from "node:crypto";
import type { RuntimeObservation } from "./runtime-support.js";

function valid(id: string): RuntimeObservation {
  const worker = { id: "morgan", name: "Morgan", companyId: "company", reportsTo: "ceo", adapterType: "paperclip_runner", permissions: {} };
  const o: RuntimeObservation = { scenarioId: id, origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", state: { worker },
    agents: [{ id: "ceo", companyId: "company", reportsTo: null }, worker], tasks: [], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [],
    reply: "Restored Morgan's previous instructions.", links: ["/ACORN/agents/morgan"], humanQueries: [],
    runs: [{ id: "run", agentId: "ceo", companyId: "company", status: "succeeded" }] };
  if (id === "agents.change-manager") {
    const riley = { id: "riley", companyId: "company", reportsTo: "ceo" };
    o.state.riley = riley; o.state.tasksBefore = [];
    o.agents = [o.agents[0]!, { ...worker, reportsTo: "riley" }, riley];
    o.activity = [{ id: "change", agentId: "ceo", action: "agent.updated", entityId: "morgan" }];
  } else if (id === "agents.hire-denied") {
    o.agents = [o.agents[0]!]; delete o.state.worker;
    Object.assign(o.state, { canCreateAgents: false, agentCreateProbeStatus: 403 });
    o.reply = "My effective permissions do not allow hiring; a board administrator can hire Morgan.";
  } else if (id === "agents.edit-instructions") {
    const revision = { id: "original", agentId: "morgan", companyId: "company", source: "seed" };
    o.state.originalInstruction = { content: "Original frontend guidance", revision };
    o.state.concurrentMarker = "Keep keyboard support";
    o.state.concurrentInstruction = { content: "Original frontend guidance\nKeep keyboard support", revision: { ...revision, id: "concurrent", source: "board" } };
    o.state.concurrentRunStatus = "running";
    o.state.sideContent = "Keep accessibility"; o.instructionSideFile = { content: "Keep accessibility" };
    o.instruction = { path: "AGENTS.md", content: "Original frontend guidance\nKeep keyboard support\nRun the relevant tests before handing work back.",
      revision: { ...revision, id: "merged", source: "api", actorAgentId: "ceo", sourceRunId: "run" } };
    o.instructionHistory = { revisions: [revision, { ...revision, id: "concurrent" }, o.instruction.revision] };
    Object.assign(o.runs[0]!, { startedAt: "2026-10-27T08:00:00Z", finishedAt: "2026-10-27T08:02:00Z" });
    o.state.concurrentRunId = "run";
    o.activity = [
      { id: "human-write", companyId: "company", action: "agent.files_updated", entityId: "morgan", actorType: "user", actorId: "local-board", createdAt: "2026-10-27T08:00:30Z",
        details: { path: "AGENTS.md", source: "board", contentHash: createHash("sha256").update("Original frontend guidance\nKeep keyboard support").digest("hex") } },
      Object.assign({ id: "agent-write", companyId: "company", action: "agent.files_updated", entityId: "morgan", actorType: "agent", actorId: "ceo", agentId: "ceo",
        details: { path: "AGENTS.md", source: "tool", contentHash: createHash("sha256").update(o.instruction.content).digest("hex") } }, { runId: "run" }),
    ];
    o.reply = "Added the rule to Morgan's instructions for future work.";
  } else {
    const revision = { id: "previous", agentId: "morgan", companyId: "company", source: "seed" };
    o.state.previousInstruction = { path: "AGENTS.md", content: "Original guidance", revision };
    o.state.unwantedInstruction = { path: "AGENTS.md", content: "Original guidance\nNever run tests", revision: { ...revision, id: "unwanted", source: "board" } };
    o.instruction = { path: "AGENTS.md", content: "Original guidance", revision: { ...revision, id: "restored", source: "restore", actorAgentId: "ceo", sourceRunId: "run" } };
    o.instructionHistory = { revisions: [revision, { ...revision, id: "unwanted" }, o.instruction.revision] };
    o.state.sideContent = "Keep accessibility"; o.instructionSideFile = { content: "Keep accessibility" };
  }
  return o;
}
describe("runtime agent oracles", () => {
  it("disables hiring with the public permission contract while preserving existing task authority", () => {
    for (const canAssignTasks of [true, false]) {
      const payload = hiringDeniedPermissions({ permissions: { canCreateAgents: true, canCreateSkills: true }, access: { canAssignTasks, taskAssignSource: canAssignTasks ? "explicit_grant" : "none", membership: null, grants: [] } });
      expect(updateAgentPermissionsSchema.safeParse(payload).success).toBe(true);
      expect(payload).toMatchObject({ canCreateAgents: false, canAssignTasks, canCreateSkills: true });
    }
    for (const access of [undefined, {}, { canAssignTasks: "true" }, { canAssignTasks: null }]) {
      const malformed = { permissions: { canCreateAgents: true, canAssignTasks: true }, access } as unknown as Pick<AgentDetail, "permissions" | "access">;
      expect(() => hiringDeniedPermissions(malformed)).toThrow("Public agent access");
    }
    expect(hiringDeniedPermissions({ permissions: { canCreateAgents: true, canAssignTasks: true }, access: { canAssignTasks: false, taskAssignSource: "none", membership: null, grants: [] } }).canAssignTasks).toBe(false);
  });
  it("accepts substantive paraphrases for each authored agent outcome", () => {
    const replies: Record<string, string> = {
      "agents.change-manager": "Morgan now reports to Riley; the reporting relationship is saved.",
      "agents.hire-denied": "Hiring is denied by my effective permissions. A board administrator can create Morgan through the human hiring flow.",
      "agents.edit-instructions": "Morgan's saved instructions now require relevant tests before a handoff; the guidance applies to future work.",
      "agents.restore-instructions": "Morgan's instruction file is back at the previous saved version; the unwanted change is removed.",
    };
    for (const [id, reply] of Object.entries(replies)) { const o = valid(id); o.reply = reply; expect(gradeRuntimeAgents(o).passed, id).toBe(true); }
  });
  for (const definition of runtimeAgentsCases) {
    it(`${definition.scenarioId} accepts independent valid evidence`, () => expect(definition.grade(valid(definition.scenarioId)).passed).toBe(true));
    it(`${definition.scenarioId} rejects missing evidence`, () => expect(definition.grade(undefined).passed).toBe(false));
  }
  it("rejects a manager change that silently swaps an account", () => {
    const o = valid("agents.change-manager"); o.agents[1]!.adapterConfig = { account: "different" };
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
  it("rejects a reporting cycle even if Morgan reports to Riley", () => {
    const o = valid("agents.change-manager"); o.agents[2]!.reportsTo = "morgan";
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
  it("rejects an unrelated run or actor's attribution", () => {
    const o = valid("agents.change-manager"); o.activity[0]!.agentId = "other";
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
  it("rejects a disguised delegated hire after denial", () => {
    const o = valid("agents.hire-denied"); o.tasks = [{ id: "hire", title: "Ask Riley to hire Morgan" }];
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
  it("rejects account setup advice misdiagnosing a permission denial", () => {
    const o = valid("agents.hire-denied"); o.reply = "Ask the board to connect a missing Anthropic account.";
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
  it("rejects plausible restoration prose with the unwanted content still saved", () => {
    const o = valid("agents.restore-instructions"); o.instruction!.content += "\nNever run tests";
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
  it("rejects restoration that erased history", () => {
    const o = valid("agents.restore-instructions"); o.instructionHistory!.revisions = [o.instruction!.revision];
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
  it("rejects a restoration attributed to another run", () => {
    const o = valid("agents.restore-instructions"); o.instruction!.revision.sourceRunId = "other-run";
    expect(gradeRuntimeAgents(o).passed).toBe(false);
  });
});

it("rejects an instruction edit that overwrote concurrent human guidance", () => {
  const o = valid("agents.edit-instructions"); o.instruction!.content = "Original frontend guidance\nRun the relevant tests before handing work back.";
  expect(gradeRuntimeAgents(o).passed).toBe(false);
});
it("uses actual file-mutation audits rather than the current reader's virtual revision actor/history", () => {
  const o = valid("agents.edit-instructions");
  o.instructionHistory = { revisions: [] };
  Object.assign(o.instruction!.revision, { actorAgentId: null, sourceRunId: null, actorUserId: "local-board" });
  expect(gradeRuntimeAgents(o).passed).toBe(true);
  for (const change of [
    { companyId: "foreign" }, { entityId: "other-agent" }, { actorId: "other-agent" }, { runId: "other-run" },
    { details: { path: "other.md", source: "tool", contentHash: o.activity[1]!.details!.contentHash } },
    { details: { path: "AGENTS.md", source: "tool", contentHash: "wrong-hash" } },
  ]) {
    const wrong = structuredClone(o); Object.assign(wrong.activity[1]!, change);
    expect(gradeRuntimeAgents(wrong).passed).toBe(false);
  }
  const late = structuredClone(o); late.activity[0]!.createdAt = "2026-10-27T08:03:00Z";
  expect(gradeRuntimeAgents(late).passed).toBe(false);
});
it("accepts an explicit unresolved revision conflict preserving the concurrent edit", () => {
  const o = valid("agents.edit-instructions"); o.instruction!.content = "Original frontend guidance\nKeep keyboard support";
  o.reply = "Morgan's instruction revision changed concurrently; the testing-rule update has an unresolved conflict.";
  expect(gradeRuntimeAgents(o).passed).toBe(true);
});
it("rejects claimed success after a conflict left the rule unsaved", () => {
  const o = valid("agents.edit-instructions"); o.instruction!.content = "Original frontend guidance\nKeep keyboard support";
  o.reply = "There was a revision conflict, but I have added the testing rule for future work.";
  expect(gradeRuntimeAgents(o).passed).toBe(false);
});

it.each(["agents.change-manager", "agents.restore-instructions"])("%s accepts real saved results without a mandatory chat href", id => {
  const o = valid(id); o.links = []; expect(gradeRuntimeAgents(o).passed).toBe(true);
});
it("keeps the explicit agent-or-revision link requirement for instruction edits", () => {
  const o = valid("agents.edit-instructions"); o.links = []; expect(gradeRuntimeAgents(o).passed).toBe(false);
});
it("accepts the exact independently saved instruction revision link", () => {
  const o = valid("agents.edit-instructions"); o.links = ["/api/agents/morgan/instructions-bundle/revision/merged"];
  expect(gradeRuntimeAgents(o).passed).toBe(true);
});
it("rejects an unrelated API route offered as an instruction revision result", () => {
  const o = valid("agents.edit-instructions"); o.links = ["/api/agents/morgan/keys"];
  expect(gradeRuntimeAgents(o).passed).toBe(false);
});

 it("restoration accepts content-addressed identity and ordinary source labels with real visible restoration history", () => {
  const o = valid("agents.restore-instructions");
  const restored = { ...o.instruction!.revision, id: "previous", source: "api" };
  o.instruction!.revision = restored;
  o.instructionHistory!.revisions[2] = restored;
  expect(gradeRuntimeAgents(o).passed).toBe(true);
  o.instructionHistory!.revisions.pop(); expect(gradeRuntimeAgents(o).passed).toBe(false);
 });
