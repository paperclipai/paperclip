import { describe, expect, it } from "vitest";
import type { AiConnectionRouterRequest } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const NOW = "2026-01-01T00:00:00.000Z";
const hour = (hours: number) => new Date(Date.parse(NOW) + hours * 3_600_000).toISOString();
const companyId = "company-1";
const members = ["member-a", "member-b"].map(id => ({
  id,
  binding: { mode: "delegated" as const, provider: "anthropic" as const, method: "subscription" as const, connectionId: `conn-${id}`, grantId: `grant-${id}` },
  profile: { provider: "acpx" as const, acpxAgent: "claude" as const, model: "claude-sonnet-5" },
}));
const request = (taskKey: string, extra: Partial<AiConnectionRouterRequest> = {}): AiConnectionRouterRequest => ({
  companyId, agentId: "agent-1", taskKey, lastMemberId: null, cursorVersion: 0, memberOrder: members.map(m => m.id), now: NOW,
  pool: { id: "pool", companyId, pluginKey: manifest.id, revision: 1, name: "Pool", enabled: true, mode: "round_robin", thresholdPercent: 90, members },
  candidates: members.map(member => ({ member, runtimeConfig: {}, notes: [] })), ...extra,
});
const cooldownKey = { scopeKind: "company" as const, scopeId: companyId, namespace: "cooldowns", stateKey: "conn-member-a:grant-member-a" };

async function setup() {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  const route = (input: AiConnectionRouterRequest) => plugin.definition.onRouteAiConnection!(input);
  const run = (type: "agent.run.failed" | "agent.run.finished", runId: string, payload: Record<string, unknown> = {}, occurredAt = NOW) =>
    harness.emit(type, { runId, agentId: "agent-1", issueId: "issue-1", errorCode: type === "agent.run.failed" ? "provider_quota" : null, finishedAt: occurredAt, ...payload }, { companyId, occurredAt, entityId: runId });
  return { harness, route, run };
}

describe("reference router worker", () => {
  it("declares only the documented router capabilities", () => {
    expect(manifest.capabilities.sort()).toEqual(["ai.connections.route", "events.subscribe", "plugin.state.read", "plugin.state.write"]);
    expect(manifest.aiConnectionRouter?.name).toBeTruthy();
  });

  it("learns a provider_quota cool-down, fails new tasks over, keeps the pin waiting and clears on success", async () => {
    const { harness, route, run } = await setup();
    expect(await route(request("issue-1"))).toEqual({ kind: "selected", memberId: "member-a" });
    await run("agent.run.failed", "run-1");
    expect(harness.getState(cooldownKey)).toMatchObject({ until: "2026-01-01T01:00:00.000Z", strikes: 1 });
    expect(await route(request("issue-2"))).toMatchObject({ kind: "selected", memberId: "member-b" });
    expect(await route(request("issue-1", { pinnedMemberId: "member-a" }))).toMatchObject({ kind: "exhausted", retryAt: "2026-01-01T01:00:00.000Z" });
    await route(request("issue-1", { now: hour(2), pinnedMemberId: "member-a" }));
    await run("agent.run.finished", "run-2", {}, hour(2.5));
    expect(harness.getState(cooldownKey)).toBeUndefined();
  });

  it("adds one strike per failed run; a redelivered event never consumes a later run's selection", async () => {
    const { harness, route, run } = await setup();
    await route(request("issue-1"));
    await run("agent.run.failed", "run-1");
    await run("agent.run.failed", "run-1");
    expect(harness.getState(cooldownKey)).toMatchObject({ strikes: 1, until: hour(1) });
    await route(request("issue-1", { pinnedMemberId: "member-a", now: hour(2) }));
    await run("agent.run.failed", "run-1");
    await run("agent.run.failed", "run-2", {}, hour(3));
    expect(harness.getState(cooldownKey)).toEqual({ strikes: 2, until: hour(5), lastRunId: "run-2" });
  });

  it("ignores an older event that arrives after a later terminal outcome", async () => {
    const { harness, route, run } = await setup();
    await route(request("issue-1"));
    await run("agent.run.finished", "run-1");
    await route(request("issue-1", { now: hour(1) }));
    await run("agent.run.failed", "run-2", {}, hour(2));
    expect(harness.getState(cooldownKey)).toMatchObject({ strikes: 1, until: hour(3) });
    await route(request("issue-1", { pinnedMemberId: "member-a", now: hour(4) }));
    await run("agent.run.finished", "run-1");
    await run("agent.run.failed", "run-2", {}, hour(2));
    expect(harness.getState(cooldownKey)).toMatchObject({ strikes: 1, until: hour(3), lastRunId: "run-2" });
    await run("agent.run.finished", "run-3", {}, hour(5));
    expect(harness.getState(cooldownKey)).toBeUndefined();
    await run("agent.run.failed", "run-2", {}, hour(2));
    expect(harness.getState(cooldownKey)).toBeUndefined();
  });

  it("ignores other failures and runs it did not route", async () => {
    const { harness, route, run } = await setup();
    await run("agent.run.failed", "run-0");
    await route(request("issue-1"));
    await run("agent.run.failed", "run-1", { errorCode: "adapter_failed" });
    expect(harness.getState(cooldownKey)).toBeUndefined();
  });

  it("routes without cool-downs when plugin state cannot be read", async () => {
    const { harness, route, run } = await setup();
    await route(request("issue-1"));
    await run("agent.run.failed", "run-1");
    harness.ctx.state.get = async () => { throw new Error("state unavailable"); };
    expect(await route(request("issue-1", { pinnedMemberId: "member-a" }))).toEqual({ kind: "selected", memberId: "member-a" });
    expect(await route(request("issue-3"))).toEqual({ kind: "selected", memberId: "member-a" });
  });
});
