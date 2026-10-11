import { describe, expect, it } from "vitest";
import {
  attachPaperclipSessionMetadataToSessionParams,
  buildEffectiveRunSessionConfigMetadata,
  buildEffectiveRunToolConnectionsConfigValue,
  resolveTaskSessionConfigFreshness,
} from "../services/heartbeat/workspaces.js";

type Connection = Parameters<
  typeof buildEffectiveRunToolConnectionsConfigValue
>[0]["installedConnections"][number];

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Example Tools",
  status: "active",
  enabled: true,
  transport: "mcp_remote",
  credentialPolicy: "shared",
  healthStatus: "ok",
  installs: [{ targetType: "company" }],
  ...overrides,
});

const value = (
  connections: Connection[],
  permittedConnectionIds: string[] = connections.map((item) => item.id),
) =>
  buildEffectiveRunToolConnectionsConfigValue({
    installedConnections: connections,
    permittedConnectionIds,
  });

describe("tool-connection session fingerprint value", () => {
  it("does not change when a health poll rewrites volatile columns", () => {
    // updateConnectionHealth rewrites these on every poll. If they reached the
    // fingerprint, each poll would rotate every task session.
    const before = value([connection()]);
    const polled = {
      ...connection(),
      updatedAt: new Date("2031-01-01T00:00:00.000Z"),
      healthCheckedAt: new Date("2031-01-01T00:00:00.000Z"),
      lastHealthAt: new Date("2031-01-01T00:00:00.000Z"),
      healthMessage: "checked",
      lastError: null,
    } as Connection;
    expect(value([polled])).toEqual(before);
  });

  it("changes when a connection is disabled or archived", () => {
    const active = value([connection()]);
    expect(value([connection({ enabled: false })])).not.toEqual(active);
    expect(value([connection({ status: "archived" })])).not.toEqual(active);
  });

  it("keeps an absent status distinct from active, because it does not attach", () => {
    // ToolConnection.status is optional. Widening undefined to "active" would
    // hide a connection that cannot attach.
    expect(value([connection({ status: undefined })])).not.toEqual(
      value([connection({ status: "active" })]),
    );
    expect(value([connection({ status: undefined })])).toEqual(
      value([connection({ status: null })]),
    );
  });

  it("changes when a connection stops being permitted", () => {
    expect(value([connection()], [])).not.toEqual(value([connection()]));
  });

  it("changes when a connection needs attention, because it stops attaching", () => {
    expect(value([connection({ healthStatus: "error" })])).not.toEqual(
      value([connection()]),
    );
  });

  it("ignores health for a per_user connection, which attaches either way", () => {
    // The attachment filter ORs `credentialPolicy === "per_user"` with the
    // health term, so health never gates these. Folding it in would reset the
    // session on the failure and again on the recovery, with no tool change.
    const perUser = { credentialPolicy: "per_user" as const };
    expect(value([connection({ ...perUser, healthStatus: "error" })])).toEqual(
      value([connection({ ...perUser, healthStatus: "ok" })]),
    );
    // ...but the policy itself is still part of the marker.
    expect(value([connection(perUser)])).not.toEqual(value([connection()]));
  });

  it("changes when a connection is installed or uninstalled", () => {
    const second = connection({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Second Tools",
    });
    expect(value([connection(), second])).not.toEqual(value([connection()]));
  });

  it("changes when a connection is renamed, because tool names embed the name", () => {
    expect(value([connection({ name: "Renamed Tools" })])).not.toEqual(
      value([connection()]),
    );
  });

  it("is stable when the resolver returns the same connections in a different order", () => {
    const second = connection({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Second Tools",
    });
    expect(value([second, connection()])).toEqual(
      value([connection(), second]),
    );
    expect(value([connection()], ["b", "a"])).toEqual(
      value([connection()], ["a", "b"]),
    );
  });
});

/**
 * The reducer tests above would all pass even if `toolConnections` never
 * reached the stored session fingerprint. These drive the real path:
 * build metadata -> save it onto session params -> resolve freshness.
 */
describe("tool-connection change rotates the task session", () => {
  const MODEL = "claude-opus-5";

  const metadataFor = (connections: Connection[]) =>
    buildEffectiveRunSessionConfigMetadata({
      adapterType: "claude_local",
      // No instructions paths, so the instructions fingerprint resolves to
      // null without touching the filesystem.
      effectiveAdapterConfig: {},
      agentRuntimeConfig: null,
      issueOverrides: null,
      workspaceConfig: null,
      environment: null,
      environmentEnv: null,
      projectEnv: null,
      routineEnv: null,
      runtimeSkills: null,
      toolConnections: value(connections),
    });

  const save = (
    metadata: Awaited<ReturnType<typeof metadataFor>>,
  ) =>
    attachPaperclipSessionMetadataToSessionParams(null, MODEL, metadata) ?? {};

  const freshness = (
    stored: Record<string, unknown>,
    metadata: Awaited<ReturnType<typeof metadataFor>>,
  ) =>
    resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: MODEL,
      taskSessionParams: stored,
      configMetadata: metadata,
    });

  it("exposes toolConnections as a fingerprint category", async () => {
    const metadata = await metadataFor([connection()]);
    expect(metadata.categories).toContain("toolConnections");
    expect(metadata.categoryFingerprints.toolConnections).toBeTruthy();
  });

  it("reuses the session when nothing about the connections changed", async () => {
    const metadata = await metadataFor([connection()]);
    const decision = freshness(save(metadata), await metadataFor([connection()]));
    expect(decision.reset).toBe(false);
    expect(decision.changedCategories).toEqual([]);
  });

  it("resets with changedCategories toolConnections when one is revoked", async () => {
    const stored = save(await metadataFor([connection()]));
    // Revocation: the connection row goes disabled/archived.
    const revoked = await metadataFor([
      connection({ status: "archived", enabled: false }),
    ]);
    const decision = freshness(stored, revoked);
    expect(decision.reset).toBe(true);
    expect(decision.changedCategories).toEqual(["toolConnections"]);
    expect(decision.reasons.join(" ")).toContain("tool connections");
  });

  it("resets with changedCategories toolConnections when one is installed", async () => {
    const stored = save(await metadataFor([connection()]));
    const added = await metadataFor([
      connection(),
      connection({
        id: "22222222-2222-2222-2222-222222222222",
        name: "Second Tools",
      }),
    ]);
    const decision = freshness(stored, added);
    expect(decision.reset).toBe(true);
    expect(decision.changedCategories).toEqual(["toolConnections"]);
  });

  it("does not reset on a health poll of a per_user connection", async () => {
    const perUser = { credentialPolicy: "per_user" as const };
    const stored = save(await metadataFor([connection(perUser)]));
    const afterFailedHealthCheck = await metadataFor([
      connection({ ...perUser, healthStatus: "error" }),
    ]);
    const decision = freshness(stored, afterFailedHealthCheck);
    expect(decision.reset).toBe(false);
    expect(decision.changedCategories).toEqual([]);
  });
});
