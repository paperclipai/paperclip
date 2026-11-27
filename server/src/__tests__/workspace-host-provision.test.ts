import { projects, type Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { resolveProjectDefaultWorkspaceId } from "../services/project-default-workspace.js";
import { workspaceRequiresCopyOnlyProvisioning } from "../services/workspace-host-provision.js";

describe("controller provision source classification", () => {
  function fixture(rows: Array<{ id: string }> = [{ id: "default-source" }], defaultId?: string, existingRows = rows) {
    const db = { select: vi.fn(() => {
      let result: unknown[] = [];
      const query = { from: vi.fn((table) => {
        result = table === projects ? [{ executionWorkspacePolicy: defaultId ? { defaultProjectWorkspaceId: defaultId } : null }]
          : defaultId ? existingRows : rows;
        return query;
      }), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(async () => result),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
      query.where.mockReturnValue(query);
      query.orderBy.mockReturnValue(query);
      return query;
    }) } as unknown as Db;
    const input = { companyId: "company", task: { id: "task", projectId: "project" },
      sourceProjectId: "project", sourceWorkspaceId: "default-source" };
    return { db, input };
  }

  it.each(["explicit", "channel", "parent", "legacy"] as const)("keeps %s source choice copy-only even on the organizational default", async source => {
    const { db, input } = fixture();
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, task: { ...input.task,
      workspaceSelection: { version: 1, source, selection: { kind: "configured_source", projectWorkspaceId: "default-source", mode: "managed_isolated" } } } })).toBe(true);
  });

  it("preserves the implicit organizational default and server-generated operator cwd", async () => {
    const { db, input } = fixture();
    expect(await workspaceRequiresCopyOnlyProvisioning(db, input)).toBe(false);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, sourceProjectId: null, sourceWorkspaceId: null,
      task: { ...input.task, workspaceSelection: { version: 1, source: "operator_cwd", selection: { kind: "task_directory" } } } })).toBe(false);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, task: null, sourceProjectId: null, sourceWorkspaceId: null })).toBe(false);
  });

  it("preserves copy-only lineage after intent clearing and source ownership changes", async () => {
    const { db, input } = fixture();
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, boundWorkspace: { metadata: { _controllerProvisionCopyOnly: true } } })).toBe(true);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, boundWorkspace: { sourceIssueId: "parent-task" } })).toBe(true);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, task: { ...input.task, projectId: null } })).toBe(true);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, sourceWorkspaceId: null })).toBe(true);
  });

  it("does not upgrade missing or fallback source identities to a default approval", async () => {
    const { db, input } = fixture([{ id: "earlier-unusable-source" }]);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, input)).toBe(true);
    expect(await workspaceRequiresCopyOnlyProvisioning(fixture([]).db, input)).toBe(true);
  });
  it("uses configured defaults before primary fallback without resolving a foreign or missing pointer into approval", async () => {
    const { db, input } = fixture([{ id: "older-source" }], "default-source", [{ id: "default-source" }]);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, input)).toBe(false);
    const missing = fixture([{ id: "older-source" }], "default-source", []);
    expect(await workspaceRequiresCopyOnlyProvisioning(missing.db, missing.input)).toBe(true);
    const foreign = fixture([{ id: "older-source" }], "foreign-source");
    expect(await resolveProjectDefaultWorkspaceId(foreign.db, { companyId: "company", projectId: "project" })).toBe("foreign-source");
    expect(await workspaceRequiresCopyOnlyProvisioning(foreign.db, { ...foreign.input, sourceProjectId: "foreign-project", sourceWorkspaceId: "foreign-source" })).toBe(true);
  });

  it("retains explicit and sticky restrictions when the configured default matches the source", async () => {
    const { db, input } = fixture([], "default-source", [{ id: "default-source" }]);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, boundWorkspace: { metadata: { _controllerProvisionCopyOnly: true } } })).toBe(true);
    expect(await workspaceRequiresCopyOnlyProvisioning(db, { ...input, task: { ...input.task,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: "default-source", mode: "managed_isolated" } } } })).toBe(true);
  });
});
