import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { readBuildCommit } from "../../build-commit.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { nativeHarnessStateBase } from "./native-harness-backup-stamp.js";
import { nativeSha256 } from "./canonical.js";

type FileIdentity = { dev: number; ino: number };
export type OriginalHarnessVolumeAnchor = {
  schema: "paperclip.native-harness-original-volume-anchor.v1";
  nonce: string;
  projectId: string; serviceId: string; environmentId: string; volumeId: string; volumeInstanceId: string;
  mountPath: string; mountIdentity: FileIdentity; instanceIdentity: FileIdentity;
  createdFrom: { deploymentId: string; commit: string; providerWitnessSha256: string };
  createdAt: string;
};
export type ReviewedOriginalHarnessVolumeWitness = {
  projectId: string; serviceId: string; environmentId: string; volumeId: string; volumeInstanceId: string;
  mountPath: string; currentDeploymentId: string; currentCommit: string;
  currentMountIdentity: FileIdentity; currentInstanceIdentity: FileIdentity;
  observedAt: string; expiresAt: string; anchorSha256: string; providerWitnessSha256: string;
};
const brand: unique symbol = Symbol("original native harness volume");
export type OriginalHarnessVolumeCapability = { readonly [brand]: true; readonly fingerprint: string };
const capabilities = new WeakMap<OriginalHarnessVolumeCapability, ReviewedOriginalHarnessVolumeWitness>();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const reject = (): never => { throw new Error("native_harness_original_volume_required"); };
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;

export function originalHarnessVolumeAnchorPath() {
  return resolve(resolvePaperclipInstanceRoot(), "recovery", "native-harness-original-volume-anchor.json");
}

async function verify(witness: ReviewedOriginalHarnessVolumeWitness) {
  const now = Date.now(), observed = Date.parse(witness.observedAt), expiry = Date.parse(witness.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expiry) || observed > now || now - observed > 120_000
    || expiry <= now || expiry - observed > 120_000 || !digest.test(witness.anchorSha256)
    || !digest.test(witness.providerWitnessSha256) || !/^[a-f0-9]{40}$/.test(witness.currentCommit)) reject();
  for (const [key, value] of Object.entries({ RAILWAY_PROJECT_ID: witness.projectId, RAILWAY_SERVICE_ID: witness.serviceId,
    RAILWAY_ENVIRONMENT_ID: witness.environmentId, RAILWAY_VOLUME_ID: witness.volumeId,
    RAILWAY_DEPLOYMENT_ID: witness.currentDeploymentId, RAILWAY_VOLUME_MOUNT_PATH: witness.mountPath })) {
    if (!value || process.env[key] !== value) reject();
  }
  if (readBuildCommit() !== witness.currentCommit || !uuid.test(witness.volumeInstanceId)) reject();
  const mount = resolve(witness.mountPath), instance = resolvePaperclipInstanceRoot(), state = nativeHarnessStateBase();
  if (!inside(mount, instance) || !inside(instance, state) || await realpath(mount) !== mount) reject();
  const anchorPath = originalHarnessVolumeAnchorPath();
  for (let path = dirname(anchorPath); path !== mount; path = dirname(path)) {
    if (!inside(mount, path)) reject();
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || path === dirname(anchorPath) && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())) reject();
  }
  const before = await lstat(anchorPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8192
    || (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()) reject();
  const handle = await open(anchorPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let anchor: OriginalHarnessVolumeAnchor;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) reject();
    const bytes = await handle.readFile();
    if (sha(bytes) !== witness.anchorSha256) reject();
    anchor = JSON.parse(bytes.toString("utf8"));
    const after = await handle.stat();
    if (after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs || after.size !== before.size) reject();
  } finally { await handle.close(); }
  if (anchor.schema !== "paperclip.native-harness-original-volume-anchor.v1" || !digest.test(anchor.nonce)
    || !/^[a-f0-9]{40}$/.test(anchor.createdFrom?.commit) || !uuid.test(anchor.createdFrom?.deploymentId)
    || !digest.test(anchor.createdFrom?.providerWitnessSha256) || !Number.isFinite(Date.parse(anchor.createdAt))) reject();
  for (const key of ["projectId", "serviceId", "environmentId", "volumeId", "volumeInstanceId", "mountPath"] as const) {
    if (anchor[key] !== witness[key]) reject();
  }
  const mountStat = await lstat(mount), instanceStat = await lstat(instance), stateStat = await lstat(state);
  if (!mountStat.isDirectory() || mountStat.isSymbolicLink() || !instanceStat.isDirectory() || instanceStat.isSymbolicLink()
    || mountStat.dev !== witness.currentMountIdentity?.dev || mountStat.ino !== witness.currentMountIdentity?.ino
    || instanceStat.dev !== witness.currentInstanceIdentity?.dev || instanceStat.ino !== witness.currentInstanceIdentity?.ino
    || !stateStat.isDirectory() || stateStat.isSymbolicLink() || await realpath(state) !== state
    || before.dev !== mountStat.dev || instanceStat.dev !== mountStat.dev || stateStat.dev !== mountStat.dev) reject();
  return nativeSha256({ witness, anchorSha256: witness.anchorSha256 });
}

export async function verifyOriginalHarnessVolumeSource(witness: ReviewedOriginalHarnessVolumeWitness): Promise<OriginalHarnessVolumeCapability> {
  const frozen = structuredClone(witness), fingerprint = await verify(frozen);
  const capability = Object.freeze({ [brand]: true as const, fingerprint });
  capabilities.set(capability, frozen);
  return capability;
}

export async function assertOriginalHarnessVolumeSource(capability: OriginalHarnessVolumeCapability) {
  const witness = capabilities.get(capability);
  if (!witness || await verify(witness) !== capability.fingerprint) reject();
}
