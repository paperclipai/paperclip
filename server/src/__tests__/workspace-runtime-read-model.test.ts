import { describe, it, expect } from "vitest";
import { selectCurrentRuntimeServiceRows } from "../services/workspace-runtime-read-model.js";

// Helper: create a minimal row object for testing purposes.
// WorkspaceRuntimeServiceRow is the full Drizzle inferred type — we construct
// the minimal shape needed for identity-key logic using any-cast so tests
// don't need to supply every Drizzle column.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRow(fields: {
  id: string;
  reuseKey?: string | null;
  scopeType?: string;
  scopeId?: string | null;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  serviceName?: string;
  command?: string | null;
  cwd?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) {
  return {
    id: fields.id,
    reuseKey: fields.reuseKey ?? null,
    scopeType: fields.scopeType ?? "project_workspace",
    scopeId: fields.scopeId ?? null,
    projectWorkspaceId: fields.projectWorkspaceId ?? null,
    executionWorkspaceId: fields.executionWorkspaceId ?? null,
    serviceName: fields.serviceName ?? "web",
    command: fields.command ?? null,
    cwd: fields.cwd ?? null,
    // Remaining Drizzle required columns — not read by selectCurrentRuntimeServiceRows
    companyId: "company-1",
    projectId: null,
    issueId: null,
    status: "running",
    lifecycle: "started",
    url: null,
    port: null,
    provider: "local_process",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "unknown",
    lastUsedAt: new Date(),
    startedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("selectCurrentRuntimeServiceRows", () => {
  it("returns empty array for empty input", () => {
    expect(selectCurrentRuntimeServiceRows([])).toEqual([]);
  });

  it("returns single row unchanged", () => {
    const row = makeRow({ id: "row-1" });
    const result = selectCurrentRuntimeServiceRows([row]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("row-1");
  });

  it("returns both rows when they have different identity keys", () => {
    const row1 = makeRow({ id: "row-1", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", serviceName: "api" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["row-1", "row-2"]);
  });

  it("deduplicates rows with the same identity key (keeps first occurrence)", () => {
    const row1 = makeRow({ id: "row-1", serviceName: "web", scopeType: "project_workspace" });
    const row2 = makeRow({ id: "row-2", serviceName: "web", scopeType: "project_workspace" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("row-1");
  });

  it("deduplicates by reuseKey when set (ignores other fields)", () => {
    const row1 = makeRow({ id: "row-1", reuseKey: "shared-key", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", reuseKey: "shared-key", serviceName: "api" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("row-1");
  });

  it("treats rows with different reuseKeys as distinct even with same other fields", () => {
    const row1 = makeRow({ id: "row-1", reuseKey: "key-a", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", reuseKey: "key-b", serviceName: "web" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(2);
  });

  it("distinguishes rows by projectWorkspaceId", () => {
    const row1 = makeRow({ id: "row-1", projectWorkspaceId: "ws-1", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", projectWorkspaceId: "ws-2", serviceName: "web" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(2);
  });

  it("distinguishes rows by executionWorkspaceId", () => {
    const row1 = makeRow({ id: "row-1", executionWorkspaceId: "ew-1", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", executionWorkspaceId: "ew-2", serviceName: "web" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(2);
  });

  it("distinguishes rows by cwd", () => {
    const row1 = makeRow({ id: "row-1", cwd: "/path/a", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", cwd: "/path/b", serviceName: "web" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(2);
  });

  it("distinguishes rows by command", () => {
    const row1 = makeRow({ id: "row-1", command: "node server.js", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", command: "node worker.js", serviceName: "web" });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(2);
  });

  it("row with reuseKey and row without are kept separately", () => {
    const row1 = makeRow({ id: "row-1", reuseKey: "some-key" });
    const row2 = makeRow({ id: "row-2", reuseKey: null });
    const result = selectCurrentRuntimeServiceRows([row1, row2]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["row-1", "row-2"]);
  });

  it("preserves insertion order of first-seen rows", () => {
    const row1 = makeRow({ id: "row-1", serviceName: "alpha" });
    const row2 = makeRow({ id: "row-2", serviceName: "beta" });
    const row3 = makeRow({ id: "row-3", serviceName: "gamma" });
    const result = selectCurrentRuntimeServiceRows([row3, row1, row2]);
    expect(result.map((r) => r.id)).toEqual(["row-3", "row-1", "row-2"]);
  });

  it("handles 3 rows where first two share an identity", () => {
    const row1 = makeRow({ id: "row-1", serviceName: "web" });
    const row2 = makeRow({ id: "row-2", serviceName: "web" }); // duplicate of row1
    const row3 = makeRow({ id: "row-3", serviceName: "api" });
    const result = selectCurrentRuntimeServiceRows([row1, row2, row3]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["row-1", "row-3"]);
  });
});
