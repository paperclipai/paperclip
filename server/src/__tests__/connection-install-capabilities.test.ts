import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  agents,
  aiConnectionPools,
  companyMemberships,
  connectionGrants,
  principalPermissionGrants,
  routines,
  toolConnections,
  toolConnectionInstalls,
  toolMcpGateways,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { connectionManagementService } from "../services/connection-management.js";
import type { AuthorizationActor } from "../services/authorization.js";
import type { ConnectionManagementResource } from "../services/connection-management-policy.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";
const userId = "capability-test-user";
const agentId = (index: number) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
const actor: AuthorizationActor = { type: "board", source: "cloud_tenant", userId };
const localActor: AuthorizationActor = { type: "board", source: "local_implicit" };
const resource: ConnectionManagementResource = {
  type: "connection_management", companyId, connectionId, operation: "configure", readOnly: false,
};
const dialect = new PgDialect();

/** Only the query transport is synthetic. Both paths use the real services and policy evaluator. */
function fixture(count = 3) {
  const agentRows = Array.from({ length: count }, (_, index) => ({
    id: agentId(index), companyId, status: "idle", role: "engineer", permissions: {}, reportsTo: null,
  }));
  const state = {
    activeMembership: true,
    membershipRole: "member",
    creatorId: userId,
    connectionPurpose: "tool",
    provider: null as string | null,
    connectionExists: true,
    missingConnections: new Set<string>(),
    agentStatus: "idle",
    installs: [] as Array<{ targetType: string; targetId: string }>,
    missingAgents: new Set<string>(),
    targetErrors: new Map<string, Error>(),
    grants: new Map<string, Record<string, unknown> | null>(),
    poolMembers: [] as Array<{ binding: { connectionId: string } }>,
    afterTargetRead: undefined as ((targetId: string) => void) | undefined,
  };
  const reads = { total: 0, targetIds: [] as string[], connections: 0, pools: 0, profiles: 0, gateways: 0 };
  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            async where(condition: SQL) {
              reads.total++;
              const query = dialect.sqlToQuery(condition);
              if (table === toolConnections) {
                reads.connections++;
                const selectedId = String(query.params[0]);
                return state.connectionExists && query.params[1] === companyId && !state.missingConnections.has(selectedId) ? [{
                  id: selectedId, companyId, createdByUserId: state.creatorId,
                  connectionPurpose: selectedId === connectionId ? state.connectionPurpose : "tool",
                  credentialPolicy: "shared", config: state.provider ? { provider: state.provider } : {}, transportConfig: {},
                }] : [];
              }
              if (table === toolConnectionInstalls) return state.installs;
              if (table === companyMemberships) return state.activeMembership && query.params[0] === companyId
                && query.params[2] === userId ? [{
                companyId, principalType: "user", principalId: userId,
                status: "active", membershipRole: state.membershipRole,
              }] : [];
              if (table === principalPermissionGrants) {
                const permissionKey = String(query.params[3]);
                return state.grants.has(permissionKey) ? [{
                  companyId, principalType: "user", principalId: userId,
                  permissionKey, scope: state.grants.get(permissionKey),
                }] : [];
              }
              if (table === connectionGrants) return [];
              if (table === aiConnectionPools) {
                reads.pools++;
                return [{ id: connectionId, config: { members: state.poolMembers } }];
              }
              if (table === toolProfiles) { reads.profiles++; return []; }
              if (table === toolMcpGateways) { reads.gateways++; return []; }
              if (table === routines) return [];
              if (table === agents) {
                if (!query.sql.includes('"agents"."id" =')) return agentRows;
                const targetId = String(query.params[0]);
                reads.targetIds.push(targetId);
                const error = state.targetErrors.get(targetId);
                if (error) throw error;
                const result = state.missingAgents.has(targetId) ? [] : agentRows
                  .filter(row => row.id === targetId)
                  .map(row => ({ ...row, status: state.agentStatus }));
                state.afterTargetRead?.(targetId);
                return result;
              }
              throw new Error(`Unexpected capability fixture query: ${query.sql}`);
            },
          };
        },
      };
    },
  } as unknown as Db;
  const management = connectionManagementService(db);
  const candidates = agentRows.map(row => row.id);
  const baseline = async (
    ids = candidates,
    probeResource = resource,
    probeActor = actor,
  ) => {
    const results = [];
    for (const targetAgentId of ids) {
      results.push(await management.capability(probeActor, "connections:profiles", {
        ...probeResource, readOnly: false, targetAgentId,
      }));
    }
    return results;
  };
  return { state, reads, management, candidates, baseline };
}

describe("connection agent-install capability batches", () => {
  it("does no database work for an empty candidate list", async () => {
    const f = fixture();
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, [])).toEqual([]);
    expect(f.reads.total).toBe(0);
  });

  it("preserves candidate order, duplicate results and target-scoped grants without retained installs", async () => {
    const f = fixture();
    f.state.creatorId = "another-user";
    f.state.grants.set("tools:manage_profiles", { targetAgentIds: [agentId(1)] });
    const candidates = [agentId(1), agentId(0), agentId(1), agentId(2)];
    const expected = await f.baseline(candidates);
    expect(expected.map(result => result.allowed)).toEqual([true, false, true, false]);
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, candidates)).toEqual(expected);
  });

  it("preserves a mixture of existing and missing candidates", async () => {
    const f = fixture();
    const candidates = [agentId(1), agentId(99), agentId(0)];
    const expected = await f.baseline(candidates);
    expect(expected.map(result => result.allowed)).toEqual([true, false, true]);
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, candidates)).toEqual(expected);
  });

  it("denies every candidate when a retained installed target is unavailable", async () => {
    const f = fixture();
    f.state.installs = [{ targetType: "agent", targetId: agentId(99) }];
    const expected = await f.baseline();
    expect(expected.every(result => !result.allowed)).toBe(true);
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(expected);
  });

  it("does not hide a retained-target policy denial behind candidate-specific permission", async () => {
    const f = fixture();
    f.state.creatorId = "another-user";
    f.state.grants.set("tools:manage_profiles", { targetAgentIds: [agentId(0)] });
    f.state.installs = [{ targetType: "agent", targetId: agentId(1) }];
    const expected = await f.baseline([agentId(0)]);
    expect(expected[0]).toMatchObject({ allowed: false });
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)])).toEqual(expected);
  });

  it("preserves candidate-dependent policy checks for an empty retained agent selector", async () => {
    const f = fixture();
    f.state.creatorId = "another-user";
    f.state.grants.set("tools:manage_profiles", { targetAgentIds: [agentId(1)] });
    f.state.installs = [{ targetType: "agent", targetId: "" }];
    const expected = await f.baseline();
    expect(expected.map(result => result.allowed)).toEqual([false, true, false]);
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(expected);
    const laterFault = new Error("later allowed candidate database fault");
    f.state.targetErrors.set(agentId(1), laterFault);
    await expect(f.baseline()).rejects.toBe(laterFault);
    await expect(f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).rejects.toBe(laterFault);
  });

  it("preserves output for retained candidates, new candidates and duplicates in the same batch", async () => {
    const f = fixture();
    f.state.installs = [{ targetType: "agent", targetId: agentId(0) }];
    const candidates = [agentId(0), agentId(2), agentId(0), agentId(99), agentId(1)];
    const expected = await f.baseline(candidates);
    expect(expected.map(result => result.allowed)).toEqual([true, true, true, false, true]);
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, candidates)).toEqual(expected);
  });

  it("stops at an earlier retained denial without visiting a later infrastructure fault", async () => {
    const f = fixture();
    f.state.installs = [
      { targetType: "agent", targetId: agentId(99) },
      { targetType: "agent", targetId: agentId(1) },
    ];
    f.state.targetErrors.set(agentId(1), new Error("later database fault"));
    const expected = await f.baseline();
    f.reads.targetIds.length = 0;
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(expected);
    expect(f.reads.targetIds).not.toContain(agentId(1));
  });

  it("propagates an earlier retained infrastructure fault before any later denial", async () => {
    const f = fixture();
    f.state.installs = [
      { targetType: "agent", targetId: agentId(0) },
      { targetType: "agent", targetId: agentId(99) },
    ];
    const fault = new Error("first database fault");
    f.state.targetErrors.set(agentId(0), fault);
    await expect(f.baseline()).rejects.toBe(fault);
    f.reads.targetIds.length = 0;
    await expect(f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).rejects.toBe(fault);
    expect(f.reads.targetIds).toEqual([agentId(0)]);
  });

  it("converts only 403 faults to denied descriptions and continues in candidate order", async () => {
    const f = fixture();
    f.state.targetErrors.set(agentId(1), Object.assign(new Error("synthetic forbidden target"), { status: 403 }));
    const expected = await f.baseline();
    expect(expected.map(result => result.allowed)).toEqual([true, false, true]);
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(expected);
  });

  it.each([409, 500])("propagates a %s fault without evaluating later candidates", async status => {
    const f = fixture();
    const fault = Object.assign(new Error("synthetic infrastructure failure"), { status });
    f.state.targetErrors.set(agentId(1), fault);
    await expect(f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).rejects.toBe(fault);
    expect(f.reads.targetIds).not.toContain(agentId(2));
  });

  it("always probes mutation authority even when a caller supplies readOnly or mutation:false", async () => {
    const f = fixture();
    f.state.installs = [{ targetType: "agent", targetId: agentId(99) }];
    expect(await f.management.capability(localActor, "connections:profiles", {
      ...resource, targetAgentId: agentId(0),
    }, { mutation: false })).toMatchObject({ allowed: true });
    const extraCallerOptions = { mutation: false, readContext: undefined };
    expect(await f.management.describeAgentInstallCapabilities(localActor, { ...resource, readOnly: true },
      [agentId(0)], extraCallerOptions)).toEqual(await f.baseline([agentId(0)], resource, localActor));
  });

  it("ignores a caller's targetAgentId when evaluating each supplied candidate", async () => {
    const f = fixture();
    f.state.creatorId = "another-user";
    f.state.grants.set("tools:manage_profiles", { targetAgentIds: [agentId(0)] });
    expect(await f.management.describeAgentInstallCapabilities(actor, { ...resource, targetAgentId: agentId(0) },
      [agentId(1)])).toEqual(await f.baseline([agentId(1)]));
  });

  it("keeps later batches and actual authorization fresh after membership revocation", async () => {
    const f = fixture();
    const description = await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)]);
    expect(description[0]).toMatchObject({ allowed: true });
    expect(description[0]).not.toHaveProperty("reauthorize");
    const context = await f.management.authorize(actor, "connections:profiles", { ...resource, targetAgentId: agentId(0) });
    f.state.activeMembership = false;
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)]))
      .toEqual(await f.baseline([agentId(0)]));
    expect((await f.baseline([agentId(0)]))[0]).toMatchObject({ allowed: false });
    await expect(f.management.authorize(actor, "connections:profiles", { ...resource, targetAgentId: agentId(0) }))
      .rejects.toMatchObject({ status: 403 });
    await expect(context.reauthorize()).rejects.toMatchObject({ status: 403 });
  });

  it("reloads target-scoped grants on the next batch", async () => {
    const f = fixture();
    f.state.creatorId = "another-user";
    f.state.grants.set("tools:manage_profiles", { targetAgentIds: [agentId(0)] });
    expect((await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)]))[0].allowed).toBe(true);
    f.state.grants.delete("tools:manage_profiles");
    expect((await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)]))[0].allowed).toBe(false);
  });

  it("reloads a deleted connection on the next batch", async () => {
    const f = fixture();
    expect((await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)]))[0].allowed).toBe(true);
    f.state.connectionExists = false;
    const result = await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)]);
    expect(result).toEqual(await f.baseline([agentId(0)]));
    expect(result[0]).toMatchObject({ allowed: false, reason: "Connection is unavailable in this company" });
  });

  it("does not reuse a prior actor's or company's descriptions", async () => {
    const f = fixture();
    expect((await f.management.describeAgentInstallCapabilities(actor, resource, [agentId(0)]))[0].allowed).toBe(true);
    const otherActor: AuthorizationActor = { ...actor, userId: "another-user" };
    const otherResource = { ...resource, companyId: agentId(98) };
    const actorResult = await f.management.describeAgentInstallCapabilities(otherActor, resource, [agentId(0)]);
    const companyResult = await f.management.describeAgentInstallCapabilities(actor, otherResource, [agentId(0)]);
    expect(actorResult).toEqual(await f.baseline([agentId(0)], resource, otherActor));
    expect(companyResult).toEqual(await f.baseline([agentId(0)], otherResource));
    expect(actorResult[0].allowed).toBe(false);
    expect(companyResult[0].allowed).toBe(false);
  });

  it("allows descriptive staleness after a retained check while fresh authorization observes deletion", async () => {
    const f = fixture(2);
    f.state.installs = [{ targetType: "agent", targetId: agentId(0) }];
    const targetResource = { ...resource, targetAgentId: agentId(1) };
    const context = await f.management.authorize(actor, "connections:profiles", targetResource);
    f.state.afterTargetRead = targetId => {
      if (targetId === agentId(0)) f.state.missingAgents.add(targetId);
    };
    const described = await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates);
    expect(described.map(result => result.allowed)).toEqual([true, true]);
    await expect(f.management.authorize(actor, "connections:profiles", targetResource))
      .rejects.toMatchObject({ status: 403 });
    await expect(context.reauthorize()).rejects.toMatchObject({ status: 403 });
    const freshDescriptions = await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates);
    expect(freshDescriptions.every(result => !result.allowed)).toBe(true);
  });

  it.each([4, 8])("checks company-installed targets once instead of N squared for N=%s", async count => {
    const f = fixture(count);
    f.state.installs = [{ targetType: "company", targetId: companyId }];
    const expected = await f.baseline();
    expect(f.reads.targetIds).toHaveLength(count * count);
    f.reads.targetIds.length = 0;
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(expected);
    expect(f.reads.targetIds).toHaveLength(count);
    expect(new Set(f.reads.targetIds)).toEqual(new Set(f.candidates));
  });

  it.each([
    "AAAAAAAA-0000-4000-8000-000000000001",
    "",
    "not-a-uuid",
  ])("uses ordinary evaluation without repeating preparation for candidate %j", async candidate => {
    const f = fixture(2);
    f.state.installs = [{ targetType: "company", targetId: companyId }];
    const candidates = [agentId(0), candidate, agentId(1)];
    const expected = await f.baseline(candidates);
    // The ordinary evaluator treats an empty selector as omitted.
    expect(expected.map(result => result.allowed)).toEqual([true, candidate === "", true]);
    f.reads.connections = 0;
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, candidates)).toEqual(expected);
    expect(f.reads.connections).toBe(candidates.length);
  });

  it.each([
    "AAAAAAAA-0000-4000-8000-000000000001",
    "not-a-uuid",
  ])("uses ordinary evaluation without repeating preparation for retained selector %j", async targetId => {
    const f = fixture();
    f.state.installs = [{ targetType: "agent", targetId }];
    const expected = await f.baseline();
    expect(expected.every(result => !result.allowed)).toBe(true);
    f.reads.connections = 0;
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(expected);
    expect(f.reads.connections).toBe(f.candidates.length);
  });

  it.each(["profileId", "gatewayId", "routineId"] as const)("retains ordinary denial behavior for a missing %s selector", async selector => {
    const f = fixture();
    const selected = { ...resource, [selector]: agentId(99) };
    const expected = await f.baseline(f.candidates, selected);
    expect(expected.every(result => !result.allowed)).toBe(true);
    expect(await f.management.describeAgentInstallCapabilities(actor, selected, f.candidates)).toEqual(expected);
  });

  it("retains recursive AI-pool checks through the ordinary path", async () => {
    const f = fixture(2);
    f.state.connectionPurpose = "ai";
    f.state.poolMembers = [{ binding: { connectionId: agentId(99) } }];
    const expected = await f.baseline();
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(expected);
    expect(f.reads.pools).toBeGreaterThan(0);
    f.state.missingConnections.add(agentId(99));
    const denied = await f.baseline();
    expect(denied.every(result => !result.allowed)).toBe(true);
    expect(await f.management.describeAgentInstallCapabilities(actor, resource, f.candidates)).toEqual(denied);
  });

  it("retains proposed-provider scope checks through the ordinary path", async () => {
    const f = fixture();
    f.state.creatorId = "another-user";
    f.state.provider = "current-provider";
    f.state.grants.set("tools:manage_profiles", { providers: ["current-provider"] });
    const selected = { ...resource, requestedProvider: "replacement-provider" };
    const expected = await f.baseline(f.candidates, selected);
    expect(expected.every(result => !result.allowed)).toBe(true);
    expect(await f.management.describeAgentInstallCapabilities(actor, selected, f.candidates)).toEqual(expected);
    f.state.grants.set("tools:manage_profiles", { providers: ["current-provider", "replacement-provider"] });
    const allowed = await f.baseline(f.candidates, selected);
    expect(allowed.every(result => result.allowed)).toBe(true);
    expect(await f.management.describeAgentInstallCapabilities(actor, selected, f.candidates)).toEqual(allowed);
  });

  it("retains configure escalation for a proposed company installation", async () => {
    const f = fixture();
    f.state.creatorId = "another-user";
    f.state.grants.set("tools:manage_profiles", null);
    expect((await f.baseline())[0].allowed).toBe(true);
    const selected = { ...resource, requestedInstallCompanyIds: [companyId] };
    const expected = await f.baseline(f.candidates, selected);
    expect(expected.every(result => !result.allowed)).toBe(true);
    expect(await f.management.describeAgentInstallCapabilities(actor, selected, f.candidates)).toEqual(expected);
  });

  it("retains inactive-agent rejection through the ordinary path", async () => {
    const f = fixture();
    f.state.agentStatus = "paused";
    const agentActor: AuthorizationActor = {
      type: "agent", source: "agent_key", companyId, agentId: agentId(0), onBehalfOfUserId: userId,
    };
    const expected = await f.baseline(f.candidates, resource, agentActor);
    expect(expected.every(result => !result.allowed)).toBe(true);
    expect(await f.management.describeAgentInstallCapabilities(agentActor, resource, f.candidates)).toEqual(expected);
  });
});
