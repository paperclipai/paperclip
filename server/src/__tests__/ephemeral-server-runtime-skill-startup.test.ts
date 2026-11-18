import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { activityLog, agentFileRoots, agents, companies, heartbeatRuns, issues, companySkillRepositorySnapshots as snapshots,
  nativeRunFinalizations, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { canonicalNativeRuntimeContextDigest, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { hasLocalRuntimeSkillObligations, preserveLocalRuntimeSkillObligations } from "../services/native-runtime/runtime-skill-preservation.js";
import { removeRuntimeAssetTree } from "../services/native-runtime/runtime-asset-retention.js";
import { assertEphemeralServerData } from "../services/ephemeral-server-contract.js";
import { volumeFreeControllerStateOwned } from "../services/native-runtime/volume-free-controller-state.js";

vi.mock("../services/native-runtime/native-harness-backup-migration.js", () => ({
  hasLocalNativeHarnessObligations: vi.fn(async () => false) }));
vi.mock("../services/native-runtime/volume-free-controller-state.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/volume-free-controller-state.js")>(),
  volumeFreeControllerStateOwned: vi.fn(),
}));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const previousHome = process.env.PAPERCLIP_HOME;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("ephemeral-runtime-skill-startup-");
  db = createDb(database.connectionString, { maxConnections: 6 });
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ephemeral-runtime-skill-startup-"));
  process.env.PAPERCLIP_HOME = home;
  const storage = createStorageService({ ...createLocalDiskStorageProvider(path.join(home, "objects")), id: "s3" });
  vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
}, 90_000);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(volumeFreeControllerStateOwned).mockReset();
  for (const table of [activityLog, nativeRunFinalizations, heartbeatRuns, issues, agentFileRoots, agents, snapshots, companies]) await db.delete(table);
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
  await db?.$client.end({ timeout: 1 });
  await database?.cleanup();
  if (home) await removeRuntimeAssetTree(home);
});

/** A native run admitted by a release that did not yet save runtime skill
 * bundles at admission: the bundle exists only on the admitting server's disk. */
async function retainedUnsavedRuntimeSkill(options: { pins?: Array<string | null> } = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Runtime skill startup", issuePrefix: `S${companyId.slice(0, 6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Legacy admission" });
  await db.insert(agentFileRoots).values({ companyId, agentId, generation: randomUUID(), entries: [] });
  await db.insert(issues).values({ id: issueId, companyId, title: "Old native run" });
  const bundle = await materializeAsset([{ path: "SKILL.md", content: Buffer.from(`# legacy ${runId}\n`), mode: 0o400 },
    { path: "notes.md", content: Buffer.from("notes\n"), mode: 0o400 }]);
  const context = nativeRuntimeContextFixture();
  context.skills = (options.pins ?? [null]).map((versionId, index) => ({ key: `legacy-${index}`, runtimeName: `legacy-${index}`, versionId, bundle }));
  context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
  const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v3",
    binding: { companyId, runId, agentId, issueId, executionWorkspaceId: runId },
    task: { identifier: "LEGACY-1", title: "Old admission", description: null, prompt: "Use the skill", workMode: "standard" },
    workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: null, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    provider: { kind: "codex", model: null },
    completionContract: { id: "contract", sha256: "saved", schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Use the skill", criteria: [{ id: "use", requirement: "Use skill" }] } },
    interactionResponses: [], credentialBindings: [], executionMode: "default", planningContext: null, runtimeContext: context });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
    status: "failed", finishedAt: new Date(), runnerProfileJson: { nativeExecutionInput: execution } });
  await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "terminal_failure", recoveryState: "blocked" });
  return { runId, bundle };
}
const lose = (bundle: { rootPath: string }) => removeRuntimeAssetTree(bundle.rootPath);
const saved = async (runId: string) => {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return Object.hasOwn(run!.runnerProfileJson ?? {}, "nativeRuntimeSkillPreservation");
};
const volumeFreeServer = () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
};

// Staging, 2026-11-18: a stack ran volume-free for twelve days on
// a release that kept runtime skill bundles only on its container disk. When
// that container stopped, every newer release refused to start with
// runtime_skill_assets_require_migration, and nothing could clear it.
it("starts a volume-free server over runtime skill bundles a lost disk held", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(true);
  const { bundle } = await retainedUnsavedRuntimeSkill();
  await removeRuntimeAssetTree(path.dirname(path.dirname(bundle.rootPath)));
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
});

it("saves bundles still on this disk to durable storage before starting", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(false);
  const { runId } = await retainedUnsavedRuntimeSkill();
  expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  expect(run!.runnerProfileJson).toHaveProperty("nativeRuntimeSkillPreservation");
  expect(volumeFreeControllerStateOwned).not.toHaveBeenCalled();
});

it("still refuses a missing bundle on a filesystem with no volume-free owner marker", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(false);
  const { bundle } = await retainedUnsavedRuntimeSkill();
  await removeRuntimeAssetTree(path.dirname(path.dirname(bundle.rootPath)));
  await expect(assertEphemeralServerData(db)).rejects.toThrow("runtime_skill_assets_require_migration");
});

it("saves the bundles still here and starts over the lost ones on a volume-free filesystem", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(true);
  const present = await retainedUnsavedRuntimeSkill(), lost = await retainedUnsavedRuntimeSkill();
  await lose(lost.bundle);
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  expect(await saved(present.runId)).toBe(true);
  expect(await saved(lost.runId)).toBe(false);
});

it("treats a bundle missing one listed file as lost, not changed", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(true);
  const { bundle } = await retainedUnsavedRuntimeSkill();
  await fs.chmod(bundle.rootPath, 0o700);
  await fs.rm(path.join(bundle.rootPath, "notes.md"));
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
});

it("does not hold startup on a non-null pin that is not a version ID, which preservation never copies", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(false);
  await retainedUnsavedRuntimeSkill({ pins: ["legacy-pin"] });
  expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
});

it("saves the null pin of a run that mixes it with a non-version pin, and settles the run", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(false);
  const { runId } = await retainedUnsavedRuntimeSkill({ pins: ["legacy-pin", null] });
  expect(await preserveLocalRuntimeSkillObligations(db)).toEqual({ bundles: 1, unsaved: [] });
  expect(await saved(runId)).toBe(true);
  expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
});

it("recaptures a bundle still here when its receipt's package is no longer durable", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(false);
  const { runId } = await retainedUnsavedRuntimeSkill();
  await preserveLocalRuntimeSkillObligations(db);
  await db.update(snapshots).set({ storage: null });
  expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
  expect(await saved(runId)).toBe(true);
});

it("refuses a storage error that looks like a missing file, even on a volume-free filesystem", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(true);
  await retainedUnsavedRuntimeSkill();
  const missing = Object.assign(new Error("temp file vanished"), { code: "ENOENT" });
  const put = vi.spyOn(storageModule.getStorageService(), "putFile").mockRejectedValue(missing);
  try { await expect(assertEphemeralServerData(db)).rejects.toThrow("runtime_skill_assets_require_migration"); }
  finally { put.mockRestore(); }
});

it("refuses when saving a bundle that is here fails, even on a volume-free filesystem", async () => {
  volumeFreeServer();
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(true);
  const { runId } = await retainedUnsavedRuntimeSkill();
  const put = vi.spyOn(storageModule.getStorageService(), "putFile").mockRejectedValue(new Error("storage offline"));
  try { await expect(assertEphemeralServerData(db)).rejects.toThrow("runtime_skill_assets_require_migration"); }
  finally { put.mockRestore(); }
  expect(await saved(runId)).toBe(false);
});

// The offline enrollment phase is this pass with a hard refusal on any unsaved
// run; the full enrollment suite needs a real S3 endpoint (ephemeral-migration.test.ts).
it("reports exactly the runs it could not save, for enrollment to refuse", async () => {
  const present = await retainedUnsavedRuntimeSkill(), lost = await retainedUnsavedRuntimeSkill();
  await lose(lost.bundle);
  expect(await preserveLocalRuntimeSkillObligations(db)).toEqual({ bundles: 1, unsaved: [lost.runId] });
  expect(await saved(present.runId)).toBe(true);
  expect(await preserveLocalRuntimeSkillObligations(db)).toEqual({ bundles: 0, unsaved: [lost.runId] });
});
