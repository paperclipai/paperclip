import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { isBoundFreshPluginTaskDirectory, releaseProviderRecoveryTransfers, stageProviderFreshWorkspace } from "./provider-fresh-workspace.js";
import type { ExecutionWorkspace } from "@paperclipai/shared";
const state = vi.hoisted(() => ({ getObject: vi.fn() }));
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({ getObject: state.getObject }) }));
let home: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); state.getObject.mockReset(); if (home) await rm(home, { recursive: true, force: true }); });
describe("fresh provider recovery transfer staging", () => {
  it.each(["valid", "company", "task", "binding", "owner", "path", "attempt", "closed", "repository", "strategy"])(
    "recognizes only the bound provider directory: %s", scenario => {
      const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
      const owner = { agentId: randomUUID(), environmentId: randomUUID(), pluginKey: "test.tasks", driverKey: "tasks" };
      const workspace = { id: workspaceId, companyId, sourceIssueId: issueId, status: "active", mode: "isolated_workspace",
        strategyType: "project_primary", providerType: "adapter_managed", repoUrl: null, branchName: null,
        cwd: `/workspaces/${workspaceId}`, metadata: { runnerTaskWorkspaceOwner: owner,
          runnerTaskFreshWorkspace: { attemptId: workspaceId, sourceRunId: randomUUID(), previousWorkspaceId: null, recoverySnapshots: [] } },
      } as unknown as ExecutionWorkspace;
      if (scenario === "company") workspace.companyId = randomUUID();
      if (scenario === "task") workspace.sourceIssueId = randomUUID();
      if (scenario === "binding") workspace.id = randomUUID();
      if (scenario === "owner") workspace.metadata!.runnerTaskWorkspaceOwner = { ...owner, agentId: randomUUID() };
      if (scenario === "path") workspace.cwd = "/workspaces/other";
      if (scenario === "attempt") workspace.metadata!.runnerTaskFreshWorkspace = { attemptId: randomUUID() };
      if (scenario === "closed") workspace.status = "archived";
      if (scenario === "repository") workspace.repoUrl = "https://github.com/example/repo.git";
      if (scenario === "strategy") workspace.strategyType = "git_worktree";
      expect(isBoundFreshPluginTaskDirectory({ companyId, issueId, workspaceId, workspace, owner })).toBe(scenario === "valid");
    });

  it("verifies immutable transfer files and reuses stable descriptors after interruption", async () => {
    home = await mkdtemp(path.join(tmpdir(), "provider-recovery-")); vi.stubEnv("PAPERCLIP_HOME", home);
    const companyId = randomUUID(), sourceRunId = randomUUID(), leaseId = randomUUID(), operationId = randomUUID();
    const archive = Buffer.from("verified archive"), manifest = Buffer.from("verified manifest");
    const stored = (bytes: Buffer, extension: string) => { const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { objectKey: `${companyId}/workspace-recovery/${sourceRunId}/${leaseId}/${sha256}.${extension}`, sha256, byteSize: bytes.length }; };
    const metadata = { schema: "paperclip.workspace-recovery-snapshot.v1", recoveryActionId: randomUUID(), leaseId,
      providerLeaseId: "retained-task", archive: stored(archive, "tar"), manifest: stored(manifest, "jsonl") };
    const db = { execute: async () => [{ id: sourceRunId }], select: () => ({ from: () => ({ where: async () => [{ id: operationId, metadata }] }) }) } as unknown as Db;
    state.getObject.mockImplementation(async (_companyId, key) => ({ stream: Readable.from([key.endsWith(".tar") ? archive : manifest]) }));
    const input = { db, companyId, issueId: randomUUID(), sourceRunId, attemptId: randomUUID(), previousWorkspaceId: randomUUID() };
    const first = await stageProviderFreshWorkspace(input);
    expect(first.recoverySnapshots).toHaveLength(1);
    expect(await readFile(first.recoverySnapshots[0].archive.path)).toEqual(archive);
    expect(await stageProviderFreshWorkspace({ ...input, existing: first })).toEqual(first);
    await rm(first.recoverySnapshots[0].archive.path);
    expect(await stageProviderFreshWorkspace({ ...input, existing: first })).toEqual(first);
    expect(state.getObject).toHaveBeenCalledTimes(3);
    await releaseProviderRecoveryTransfers(companyId, first);
    await expect(readFile(first.recoverySnapshots[0].archive.path)).rejects.toThrow();
    expect(await stageProviderFreshWorkspace({ ...input, existing: first })).toEqual(first);
    expect(state.getObject).toHaveBeenCalledTimes(5);
    await chmod(first.recoverySnapshots[0].archive.path, 0o600);
    await writeFile(first.recoverySnapshots[0].archive.path, "corrupt");
    await expect(stageProviderFreshWorkspace(input)).rejects.toThrow();
    expect(state.getObject).toHaveBeenCalledTimes(5);
  });
});
