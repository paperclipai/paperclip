import { describe, expect, it } from "vitest";
import { selectCurrentRuntimeServiceRows } from "./workspace-runtime-read-model.js";

// Minimal row factory — only fields used by the identity-key logic.
type MinimalRow = {
  reuseKey: string | null;
  scopeType: string;
  scopeId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  serviceName: string;
  command: string | null;
  cwd: string | null;
  id: string;
};

function makeRow(overrides: Partial<MinimalRow> & { id: string }): MinimalRow {
  return {
    reuseKey: null,
    scopeType: "project_workspace",
    scopeId: null,
    projectWorkspaceId: "ws-1",
    executionWorkspaceId: null,
    serviceName: "dev",
    command: null,
    cwd: null,
    ...overrides,
  };
}

// ============================================================================
// selectCurrentRuntimeServiceRows — empty / trivial inputs
// ============================================================================

describe("selectCurrentRuntimeServiceRows — trivial", () => {
  it("returns empty array for empty input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(selectCurrentRuntimeServiceRows([] as any)).toEqual([]);
  });

  it("returns single row unchanged", () => {
    const row = makeRow({ id: "row-1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([row] as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(row);
  });
});

// ============================================================================
// selectCurrentRuntimeServiceRows — reuseKey deduplication
// ============================================================================

describe("selectCurrentRuntimeServiceRows — reuseKey identity", () => {
  it("keeps only the first row per reuseKey (ordered by input)", () => {
    const first = makeRow({ id: "row-1", reuseKey: "key-A" });
    const second = makeRow({ id: "row-2", reuseKey: "key-A" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([first, second] as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first);
  });

  it("keeps rows with distinct reuseKeys", () => {
    const a = makeRow({ id: "row-1", reuseKey: "key-A" });
    const b = makeRow({ id: "row-2", reuseKey: "key-B" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b] as any);
    expect(result).toHaveLength(2);
  });

  it("reuseKey takes precedence over composite key fields", () => {
    // Two rows: same composite fields, different reuseKeys => both kept
    const a = makeRow({ id: "row-1", reuseKey: "key-A", serviceName: "dev" });
    const b = makeRow({ id: "row-2", reuseKey: "key-B", serviceName: "dev" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b] as any);
    expect(result).toHaveLength(2);
  });
});

// ============================================================================
// selectCurrentRuntimeServiceRows — composite key deduplication
// ============================================================================

describe("selectCurrentRuntimeServiceRows — composite key identity", () => {
  it("deduplicates rows with identical composite key fields", () => {
    const first = makeRow({ id: "row-1" });
    const second = makeRow({ id: "row-2" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([first, second] as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first);
  });

  it("keeps rows differing only in serviceName", () => {
    const a = makeRow({ id: "row-1", serviceName: "dev" });
    const b = makeRow({ id: "row-2", serviceName: "build" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b] as any);
    expect(result).toHaveLength(2);
  });

  it("keeps rows differing only in scopeType", () => {
    const a = makeRow({ id: "row-1", scopeType: "project_workspace" });
    const b = makeRow({ id: "row-2", scopeType: "execution_workspace" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b] as any);
    expect(result).toHaveLength(2);
  });

  it("keeps rows differing only in command", () => {
    const a = makeRow({ id: "row-1", command: "pnpm dev" });
    const b = makeRow({ id: "row-2", command: "pnpm start" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b] as any);
    expect(result).toHaveLength(2);
  });

  it("keeps rows differing only in cwd", () => {
    const a = makeRow({ id: "row-1", cwd: "/app/frontend" });
    const b = makeRow({ id: "row-2", cwd: "/app/backend" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b] as any);
    expect(result).toHaveLength(2);
  });

  it("keeps rows differing only in executionWorkspaceId", () => {
    const a = makeRow({ id: "row-1", executionWorkspaceId: "ew-1" });
    const b = makeRow({ id: "row-2", executionWorkspaceId: "ew-2" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b] as any);
    expect(result).toHaveLength(2);
  });

  it("treats null composite key fields as empty strings in the key", () => {
    // Both rows: projectWorkspaceId=null, same other fields → same identity
    const first = makeRow({ id: "row-1", projectWorkspaceId: null });
    const second = makeRow({ id: "row-2", projectWorkspaceId: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([first, second] as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first);
  });
});

// ============================================================================
// selectCurrentRuntimeServiceRows — ordering guarantee
// ============================================================================

describe("selectCurrentRuntimeServiceRows — order", () => {
  it("preserves relative order of distinct rows", () => {
    const a = makeRow({ id: "row-1", serviceName: "alpha" });
    const b = makeRow({ id: "row-2", serviceName: "beta" });
    const c = makeRow({ id: "row-3", serviceName: "gamma" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = selectCurrentRuntimeServiceRows([a, b, c] as any);
    expect(result.map((r: MinimalRow) => r.id)).toEqual(["row-1", "row-2", "row-3"]);
  });
});
