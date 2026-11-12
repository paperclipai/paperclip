import { randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { originalHarnessVolumeAnchorPath, verifyOriginalHarnessVolumeSource, assertOriginalHarnessVolumeSource,
  type OriginalHarnessVolumeAnchor, type ReviewedOriginalHarnessVolumeWitness } from "./native-harness-original-volume.js";

vi.mock("../../build-commit.js", () => ({ readBuildCommit: () => "a".repeat(40) }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-original-volume-"))); roots.push(root);
  const projectId = randomUUID(), serviceId = randomUUID(), environmentId = randomUUID(), volumeId = randomUUID(), deploymentId = randomUUID();
  for (const [key, value] of Object.entries({ PAPERCLIP_HOME: root, PAPERCLIP_INSTANCE_ID: "default", RAILWAY_PROJECT_ID: projectId,
    RAILWAY_SERVICE_ID: serviceId, RAILWAY_ENVIRONMENT_ID: environmentId, RAILWAY_VOLUME_ID: volumeId,
    RAILWAY_DEPLOYMENT_ID: deploymentId, RAILWAY_VOLUME_MOUNT_PATH: root })) vi.stubEnv(key, value);
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "instances/default/runtime/paperclip-runner/durable-sessions"));
  const anchorPath = originalHarnessVolumeAnchorPath(); await mkdir(join(root, "instances/default/recovery"), { recursive: true, mode: 0o700 });
  await mkdir(process.env.PAPERCLIP_RUNNER_STATE_DIR!, { recursive: true, mode: 0o700 });
  const m = await lstat(root), i = await lstat(join(root, "instances/default"));
  const anchor: OriginalHarnessVolumeAnchor = { schema: "paperclip.native-harness-original-volume-anchor.v1", nonce: "b".repeat(64),
    projectId, serviceId, environmentId, volumeId, volumeInstanceId: randomUUID(), mountPath: root,
    mountIdentity: { dev: m.dev, ino: m.ino }, instanceIdentity: { dev: i.dev, ino: i.ino },
    createdFrom: { deploymentId: randomUUID(), commit: "c".repeat(40), providerWitnessSha256: "d".repeat(64) }, createdAt: new Date().toISOString() };
  const bytes = Buffer.from(JSON.stringify(anchor)); await writeFile(anchorPath, bytes, { mode: 0o600 });
  const witness: ReviewedOriginalHarnessVolumeWitness = { projectId, serviceId, environmentId, volumeId, volumeInstanceId: anchor.volumeInstanceId,
    mountPath: root, currentDeploymentId: deploymentId, currentCommit: "a".repeat(40), currentMountIdentity: { dev: m.dev, ino: m.ino },
    currentInstanceIdentity: { dev: i.dev, ino: i.ino }, observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), anchorSha256: createHash("sha256").update(bytes).digest("hex"), providerWitnessSha256: "e".repeat(64) };
  return { root, anchorPath, anchor, witness };
}

it("requires the positive original-volume anchor and permits a later normal deployment", async () => {
  const { witness } = await fixture();
  const capability = await verifyOriginalHarnessVolumeSource(witness);
  await expect(assertOriginalHarnessVolumeSource(capability)).resolves.toBeUndefined();
  expect(capability.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  await expect(assertOriginalHarnessVolumeSource({ fingerprint: capability.fingerprint } as never)).rejects.toThrow("native_harness_original_volume_required");
});
it.each(["expired", "future", "wrong-deployment", "missing-volume", "wrong-mount", "external-state", "changed-anchor", "public-anchor", "symlink-anchor"])("refuses %s", async control => {
  const { root, witness, anchorPath } = await fixture();
  if (control === "expired") witness.observedAt = new Date(Date.now() - 120_001).toISOString();
  if (control === "future") witness.observedAt = new Date(Date.now() + 1000).toISOString();
  if (control === "wrong-deployment") vi.stubEnv("RAILWAY_DEPLOYMENT_ID", randomUUID());
  if (control === "missing-volume") vi.stubEnv("RAILWAY_VOLUME_ID", "");
  if (control === "wrong-mount") vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "/");
  if (control === "external-state") vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", "/tmp/outside-instance");
  if (control === "changed-anchor") await writeFile(anchorPath, "{}");
  if (control === "public-anchor") await chmod(anchorPath, 0o644);
  if (control === "symlink-anchor") { await rm(anchorPath); const other = join(root, "alias.json"); await writeFile(other, "{}"); await symlink(other, anchorPath); }
  await expect(verifyOriginalHarnessVolumeSource(witness)).rejects.toThrow();
});
it("revalidates the anchor and current deployment before publication", async () => {
  const { witness, anchorPath } = await fixture();
  const capability = await verifyOriginalHarnessVolumeSource(witness);
  await writeFile(anchorPath, "{}");
  await expect(assertOriginalHarnessVolumeSource(capability)).rejects.toThrow("native_harness_original_volume_required");
});
it("treats creation device/inode as provenance after a provider-confirmed remount", async () => {
  const { witness, anchor, anchorPath } = await fixture();
  anchor.mountIdentity = { dev: 1, ino: 2 }; anchor.instanceIdentity = { dev: 1, ino: 3 };
  const bytes = Buffer.from(JSON.stringify(anchor)); await writeFile(anchorPath, bytes);
  witness.anchorSha256 = createHash("sha256").update(bytes).digest("hex");
  await expect(verifyOriginalHarnessVolumeSource(witness)).resolves.toBeDefined();
  witness.currentMountIdentity.dev++;
  await expect(verifyOriginalHarnessVolumeSource(witness)).rejects.toThrow("native_harness_original_volume_required");
});
