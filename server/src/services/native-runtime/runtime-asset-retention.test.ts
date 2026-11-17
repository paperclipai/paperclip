import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { materializeAsset } from "./runtime-context.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { removeRuntimeAssetTree, runtimeAssetRetention, RUNTIME_ASSET_RETENTION_MS } from "./runtime-asset-retention.js";

let home: string;
const originalHome = process.env.PAPERCLIP_HOME;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-asset-gc-")); process.env.PAPERCLIP_HOME = home; });
afterEach(async () => {
  await removeRuntimeAssetTree(home);
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = originalHome;
  vi.restoreAllMocks();
});
function database(rows: unknown[] = []) {
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }));
  return { db: { select } as unknown as Db, select };
}
async function age(digest: string) {
  const manifest = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets", "manifests", `${digest}.json`);
  const old = new Date(Date.now() - RUNTIME_ASSET_RETENTION_MS - 1_000);
  await fs.utimes(manifest, old, old);
}
describe("runtime asset retention", () => {
  it("pins shared repositories as well as wrappers while removing unrelated expired assets", async () => {
    const repository = await materializeAsset([{ path: "skills/one/SKILL.md", content: Buffer.from("original"), mode: 0o444 }]);
    const wrapper = await materializeAsset([{ path: "SKILL.md", content: Buffer.from("wrapper"), mode: 0o444 }]);
    const unrelated = await materializeAsset([{ path: "other", content: Buffer.from("unreferenced"), mode: 0o444 }]);
    const context = nativeRuntimeContextFixture();
    context.instructions.bundle = wrapper;
    context.instructions.entryPath = "SKILL.md";
    context.skills = [{ key: "one", runtimeName: "one", versionId: "version", bundle: wrapper, repository: { bundle: repository, entryPath: "skills/one/SKILL.md", policyPath: null } }];
    context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
    const binding = { companyId: "company", runId: "run", agentId: "agent", issueId: "issue", executionWorkspaceId: "workspace" };
    const input = { schema: "paperclip.native-execution-input.v12", binding, homeMode: "isolated", executionMode: "default", planningContext: null,
      task: { identifier: "TEST-1", title: "test", description: null, prompt: "test", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: null, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      provider: { kind: "codex", model: null, approvalPolicy: "never" }, completionContract: { id: "contract", sha256: "hash", schemaVersion: "test", contract: { revision: "1", objective: "test", criteria: [{ id: "test", requirement: "test" }] } },
      interactionResponses: [], credentialBindings: [], runtimeContext: context };
    for (const asset of [repository, wrapper, unrelated]) await age(asset.digest);
    const { db } = database([{ id: "run", companyId: "company", agentId: "agent", input }]);
    await runtimeAssetRetention(db).tick(new AbortController().signal);
    expect(await fs.stat(repository.rootPath).catch(() => null)).not.toBeNull();
    expect(await fs.stat(wrapper.rootPath).catch(() => null)).not.toBeNull();
    expect(await fs.stat(unrelated.rootPath).catch(() => null)).toBeNull();
  });
  it("has no database work when empty/fresh, removes expired copies and rebuilds the same digest", async () => {
    const { db, select } = database();
    const worker = runtimeAssetRetention(db);
    await worker.tick(new AbortController().signal);
    expect(worker.nextRunAt()).toBeNull();
    expect(select).not.toHaveBeenCalled();
    const files = [{ path: "SKILL.md", content: Buffer.from("immutable skill"), mode: 0o444 }];
    const asset = await materializeAsset(files);
    await worker.tick(new AbortController().signal);
    expect(worker.nextRunAt()).toBeGreaterThan(Date.now());
    expect(select).not.toHaveBeenCalled();
    await age(asset.digest);
    await worker.tick(new AbortController().signal);
    expect(select).toHaveBeenCalledOnce();
    expect(await fs.stat(asset.rootPath).catch(() => null)).toBeNull();
    expect(worker.nextRunAt()).toBeNull();
    await worker.tick(new AbortController().signal);
    expect(select).toHaveBeenCalledOnce();
    expect(await materializeAsset(files)).toEqual(asset);
  });
  it("keeps files when an unfinished run has no trustworthy input", async () => {
    const asset = await materializeAsset([{ path: "SKILL.md", content: Buffer.from("pinned skill"), mode: 0o444 }]);
    await age(asset.digest);
    const { db } = database([{ id: "run", companyId: "company", agentId: "agent", input: null }]);
    const worker = runtimeAssetRetention(db);
    await worker.tick(new AbortController().signal);
    expect((await fs.stat(asset.rootPath)).isDirectory()).toBe(true);
    expect(worker.nextRunAt()).toBeNull();
  });
});
