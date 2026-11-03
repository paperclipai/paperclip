import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { executionWorkspaceRestorePoints, executionWorkspaces, type Db } from "@paperclipai/db";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import type { StorageService } from "../storage/types.js";
import {
  applyRestorePoint,
  captureRestorePoint,
  currentRestorePointSnapshot,
  decodeRestorePointPayload,
  importRestorePoint,
  openRestorePoint,
  restorePointHistoryDigest,
  RestorePointRestoreFailure,
  sealRestorePoint,
  type RestorePointLimits,
  type RestorePointManifest,
} from "./git-restore-point.js";
import { notifyGitRestorePointWork } from "./git-restore-point-ledger.js";
import { gitCacheCommand } from "./git-workspace-restoration.js";
import { TASK_DIRECTORY_RETENTION_KEY } from "./isolated-task-directory-snapshot.js";

export const GIT_RESTORE_POINT_SCHEMA = "paperclip.git-restore-point.v1";
const NAMESPACE = "git-restore-points";
const MAX_RESTORE_POINT_BYTES = 512 * 1024 * 1024;

export type GitRestorePointRef = {
  schema: typeof GIT_RESTORE_POINT_SCHEMA;
  id: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  key: StoredSecretVersionMaterial;
  generation: number;
  head: string;
  index: string | null;
  worktree: string | null;
  ignored?: string;
  modes: Array<{ path: string; mode: number }>;
  history?: string;
  headOnRemote: boolean;
  appliedAt?: string | null;
  expiredAt?: string;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const CHECKOUT_NAME = /^[A-Za-z0-9._-]{1,200}$/;

function restorePointObjectKey(companyId: string, workspaceId: string, generation: number, id: string, checkout?: string) {
  if (checkout !== undefined && (!CHECKOUT_NAME.test(checkout) || checkout === "." || checkout === "..")) {
    throw new RestorePointRestoreFailure("invalid_restore_point_reference");
  }
  return `${companyId}/${NAMESPACE}/${workspaceId}/${generation}/${checkout ? `checkouts/${checkout}/` : ""}${id}.pcrp`;
}

export function validateGitRestorePointRef(value: unknown, workspace: { companyId: string; id: string }, checkout?: string): GitRestorePointRef {
  const ref = value as GitRestorePointRef | null;
  const sha = /^[0-9a-f]{40}$/;
  let expectedKey: string | null = null;
  try { expectedKey = ref ? restorePointObjectKey(workspace.companyId, workspace.id, ref.generation, ref.id, checkout) : null; } catch { expectedKey = null; }
  if (!ref || ref.schema !== GIT_RESTORE_POINT_SCHEMA || typeof ref.id !== "string"
    || expectedKey === null || ref.objectKey !== expectedKey
    || !/^[0-9a-f]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.byteSize) || ref.byteSize <= 0 || ref.byteSize > MAX_RESTORE_POINT_BYTES
    || !ref.key || typeof ref.key !== "object" || Array.isArray(ref.key)
    || !Number.isSafeInteger(ref.generation) || ref.generation < 1
    || !sha.test(ref.head) || (ref.index !== null && !sha.test(ref.index)) || (ref.worktree !== null && !sha.test(ref.worktree))
    || (ref.index === null) !== (ref.worktree === null) || typeof ref.headOnRemote !== "boolean"
    || (ref.ignored !== undefined && (typeof ref.ignored !== "string" || !sha.test(ref.ignored)))
    || (ref.history !== undefined && !/^[0-9a-f]{64}$/.test(ref.history))
    || !Array.isArray(ref.modes) || ref.modes.length > 20_000 || ref.modes.some((entry) => !entry || typeof entry.path !== "string"
      || entry.path.startsWith("/") || entry.path.split("/").includes("..") || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
    || (ref.appliedAt != null && !Number.isFinite(Date.parse(ref.appliedAt)))
    || (ref.expiredAt !== undefined && !Number.isFinite(Date.parse(ref.expiredAt)))) {
    throw new RestorePointRestoreFailure("invalid_restore_point_reference");
  }
  return ref;
}

export async function storeGitRestorePoint(input: {
  db: Db;
  storage: StorageService;
  workspace: { companyId: string; id: string; sourceIssueId: string | null };
  cwd: string;
  generation: number;
  checkout?: string;
  upstreamCommits: readonly string[];
  headOnRemote: boolean;
  resolvePreserveCommits?: () => Promise<readonly string[]>;
  limits?: Partial<RestorePointLimits>;
  signal?: AbortSignal;
}): Promise<{ ref: GitRestorePointRef; ledgerId: string; manifest: RestorePointManifest } | null> {
  const history = await restorePointHistoryDigest(input.cwd, input.signal);
  const preserveCommits = await input.resolvePreserveCommits?.();
  const captured = await captureRestorePoint({ cwd: input.cwd, upstreamCommits: input.upstreamCommits, preserveCommits,
    limits: input.limits, signal: input.signal });
  if (!captured) return null;
  if (await restorePointHistoryDigest(input.cwd, input.signal) !== history) throw new RestorePointRestoreFailure("restore_point_history_changed");
  const id = randomUUID();
  const identity = { companyId: input.workspace.companyId, workspaceId: input.workspace.id, restorePointId: id, generation: input.generation };
  const sealed = await sealRestorePoint(captured.payload, identity);
  const objectKey = restorePointObjectKey(input.workspace.companyId, input.workspace.id, input.generation, id, input.checkout);
  const ledgerId = await storeSealedRestorePoint({ db: input.db, storage: input.storage, workspace: input.workspace,
    generation: input.generation, checkoutName: input.checkout ?? "", objectKey, sealed, signal: input.signal });
  const { manifest } = captured;
  return {
    ledgerId,
    manifest,
    ref: {
      schema: GIT_RESTORE_POINT_SCHEMA,
      id,
      objectKey,
      sha256: sealed.sha256,
      byteSize: sealed.ciphertext.length,
      key: sealed.key,
      generation: input.generation,
      head: manifest.head,
      index: manifest.index,
      worktree: manifest.worktree,
      ...(manifest.ignored ? { ignored: manifest.ignored } : {}),
      modes: manifest.modes,
      history,
      headOnRemote: input.headOnRemote,
      appliedAt: null,
    },
  };
}

export async function storeSealedRestorePoint(input: {
  db: Db;
  storage: StorageService;
  workspace: { companyId: string; id: string; sourceIssueId: string | null };
  generation: number;
  checkoutName: string;
  objectKey: string;
  sealed: { ciphertext: Buffer; sha256: string };
  signal?: AbortSignal;
}): Promise<string> {
  const [ledger] = await input.db.transaction(async (tx) => {
    await notifyGitRestorePointWork(tx, `workspace:${input.workspace.id}`);
    await tx.update(executionWorkspaceRestorePoints).set({ status: "superseded", updatedAt: new Date() })
      .where(and(eq(executionWorkspaceRestorePoints.executionWorkspaceId, input.workspace.id),
        eq(executionWorkspaceRestorePoints.generation, input.generation),
        eq(executionWorkspaceRestorePoints.checkoutName, input.checkoutName),
        eq(executionWorkspaceRestorePoints.status, "pending")));
    return tx.insert(executionWorkspaceRestorePoints).values({
      companyId: input.workspace.companyId,
      executionWorkspaceId: input.workspace.id,
      sourceIssueId: input.workspace.sourceIssueId,
      generation: input.generation,
      checkoutName: input.checkoutName,
      objectKey: input.objectKey,
      sha256: input.sealed.sha256,
      byteSize: input.sealed.ciphertext.length,
      status: "pending",
    }).returning({ id: executionWorkspaceRestorePoints.id });
  });
  try {
    await input.storage.putFile({
      objectKey: input.objectKey,
      companyId: input.workspace.companyId,
      namespace: NAMESPACE,
      originalFilename: null,
      contentType: "application/octet-stream",
      body: input.sealed.ciphertext,
    });
    const stored = await readRestorePointObject(input.storage, input.workspace.companyId, input.objectKey, input.signal);
    if (createHash("sha256").update(stored).digest("hex") !== input.sealed.sha256) {
      throw new RestorePointRestoreFailure("stored_restore_point_mismatch");
    }
  } catch (error) {
    await abandonGitRestorePoint(input.db, ledger!.id).catch(() => undefined);
    throw error;
  }
  return ledger!.id;
}

export async function activateGitRestorePoints(tx: Tx, input: { ledgerIds: string[]; workspaceId: string; at: Date }) {
  if (input.ledgerIds.length === 0) return;
  await notifyGitRestorePointWork(tx, `workspace:${input.workspaceId}`);
  await tx.update(executionWorkspaceRestorePoints)
    .set({ status: "superseded", updatedAt: input.at })
    .where(and(eq(executionWorkspaceRestorePoints.executionWorkspaceId, input.workspaceId),
      notInArray(executionWorkspaceRestorePoints.id, input.ledgerIds),
      inArray(executionWorkspaceRestorePoints.status, ["pending", "active"])));
  const activated = await tx.update(executionWorkspaceRestorePoints)
    .set({ status: "active", activatedAt: input.at, deleteAfter: input.at, updatedAt: input.at })
    .where(and(inArray(executionWorkspaceRestorePoints.id, input.ledgerIds), eq(executionWorkspaceRestorePoints.status, "pending")))
    .returning({ id: executionWorkspaceRestorePoints.id });
  if (activated.length !== input.ledgerIds.length) throw new RestorePointRestoreFailure("restore_point_not_pending");
}

export async function restorePointHistoryUnchanged(ref: GitRestorePointRef, cwd: string, signal?: AbortSignal) {
  return ref.history === undefined || await restorePointHistoryDigest(cwd, signal) === ref.history;
}

const modesKey = (modes: Array<{ path: string; mode: number }>) => JSON.stringify(modes.map(entry => [entry.path, entry.mode]));

export function restorePointSnapshotMatches(ref: GitRestorePointRef, snapshot: { head: string; index: string | null; worktree: string | null;
  ignored: string | null; modes: Array<{ path: string; mode: number }> }) {
  return snapshot.head === ref.head && snapshot.index === ref.index && snapshot.worktree === ref.worktree && snapshot.ignored === (ref.ignored ?? null)
    && modesKey(snapshot.modes) === modesKey(ref.modes);
}

export async function abandonGitRestorePointsByKey(db: Db, workspaceId: string, objectKeys: string[]) {
  if (objectKeys.length === 0) return;
  await db.update(executionWorkspaceRestorePoints)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(and(eq(executionWorkspaceRestorePoints.executionWorkspaceId, workspaceId), inArray(executionWorkspaceRestorePoints.objectKey, objectKeys),
      inArray(executionWorkspaceRestorePoints.status, ["pending", "active"])));
}

export async function abandonGitRestorePoint(db: Db, ledgerId: string) {
  await db.update(executionWorkspaceRestorePoints)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(and(eq(executionWorkspaceRestorePoints.id, ledgerId), inArray(executionWorkspaceRestorePoints.status, ["pending", "active"])));
}

export async function readRestorePointObject(storage: StorageService, companyId: string, objectKey: string, signal?: AbortSignal) {
  const { stream } = await storage.getObject(companyId, objectKey);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_RESTORE_POINT_BYTES) throw new RestorePointRestoreFailure("restore_point_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function loadGitRestorePoint(input: {
  storage: StorageService;
  workspace: { companyId: string; id: string };
  ref: GitRestorePointRef;
  signal?: AbortSignal;
}): Promise<{ payload: Buffer; manifest: RestorePointManifest }> {
  if (input.ref.expiredAt) throw new RestorePointRestoreFailure("restore_point_expired");
  const ciphertext = await readRestorePointObject(input.storage, input.workspace.companyId, input.ref.objectKey, input.signal)
    .catch((error) => {
      if (error instanceof RestorePointRestoreFailure) throw error;
      throw new RestorePointRestoreFailure("restore_point_unavailable");
    });
  if (ciphertext.length !== input.ref.byteSize) throw new RestorePointRestoreFailure("ciphertext_size_mismatch");
  const payload = await openRestorePoint({
    ciphertext,
    sha256: input.ref.sha256,
    key: input.ref.key,
    identity: { companyId: input.workspace.companyId, workspaceId: input.workspace.id, restorePointId: input.ref.id, generation: input.ref.generation },
  });
  const { manifest } = decodeRestorePointPayload(payload);
  if (manifest.head !== input.ref.head || manifest.index !== input.ref.index || manifest.worktree !== input.ref.worktree
    || (manifest.ignored ?? null) !== (input.ref.ignored ?? null)
    || modesKey(manifest.modes) !== modesKey(input.ref.modes)) {
    throw new RestorePointRestoreFailure("restore_point_manifest_mismatch");
  }
  return { payload, manifest };
}

export async function ensureGitRestorePointCommit(input: {
  storage: StorageService;
  workspace: { companyId: string; id: string };
  ref: GitRestorePointRef;
  repositoryCwd: string;
  signal?: AbortSignal;
}) {
  if (input.ref.headOnRemote) return;
  const present = await importNeeded(input.repositoryCwd, input.ref.head);
  if (!present) return;
  const { payload } = await loadGitRestorePoint(input);
  await importRestorePoint({ repositoryCwd: input.repositoryCwd, payload, signal: input.signal });
}

async function importNeeded(repositoryCwd: string, commit: string) {
  return !await gitCacheCommand(repositoryCwd, ["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false);
}

export async function applyGitRestorePointToWorktree(input: {
  storage: StorageService;
  workspace: { companyId: string; id: string };
  ref: GitRestorePointRef;
  repositoryCwd: string;
  worktreePath: string;
  signal?: AbortSignal;
}) {
  const current = await currentRestorePointSnapshot(input.worktreePath, input.signal);
  const matches = restorePointSnapshotMatches(input.ref, current);
  if (!matches && (current.head !== input.ref.head || current.index !== null || current.worktree !== null || current.ignored !== null || current.modes.length > 0)) {
    throw new RestorePointRestoreFailure("worktree_diverged_from_restore_point");
  }
  const { payload } = await loadGitRestorePoint(input);
  const manifest = await importRestorePoint({ repositoryCwd: input.repositoryCwd, payload, signal: input.signal });
  if (!matches) await applyRestorePoint({ cwd: input.worktreePath, manifest, signal: input.signal });
}

function expireRestorePointRecipe(key: string, recipe: Record<string, any>, objectKey: string, at: string) {
  const expire = (ref: Record<string, unknown> | undefined) => ref?.objectKey === objectKey ? { ...ref, expiredAt: at } : ref;
  if (key === TASK_DIRECTORY_RETENTION_KEY) return recipe.restorePoint ? { ...recipe, restorePoint: expire(recipe.restorePoint) } : recipe;
  return {
    ...recipe,
    ...(recipe.restorePoint ? { restorePoint: expire(recipe.restorePoint) } : {}),
    ...(recipe.contents ? { contents: { ...recipe.contents, checkouts: (recipe.contents.checkouts ?? []).map((checkout: Record<string, any>) =>
      checkout.restorePoint ? { ...checkout, restorePoint: expire(checkout.restorePoint) } : checkout) } } : {}),
  };
}

export async function markGitRestorePointExpired(db: Db, restorePoint: { companyId: string; executionWorkspaceId: string; objectKey: string }) {
  const at = new Date().toISOString();
  for (const key of ["gitCacheRestoration", TASK_DIRECTORY_RETENTION_KEY]) {
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt += 1) {
      const [row] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.id, restorePoint.executionWorkspaceId), eq(executionWorkspaces.companyId, restorePoint.companyId)));
      const recipe = row?.metadata?.[key] as Record<string, any> | undefined;
      if (!recipe) { settled = true; break; }
      const next = expireRestorePointRecipe(key, recipe, restorePoint.objectKey, at);
      if (JSON.stringify(next) === JSON.stringify(recipe)) { settled = true; break; }
      const updated = await db.update(executionWorkspaces).set({
        metadata: sql`jsonb_set(${executionWorkspaces.metadata}, ${`{${key}}`}::text[], ${JSON.stringify(next)}::jsonb)`,
        updatedAt: new Date(),
      }).where(and(eq(executionWorkspaces.id, restorePoint.executionWorkspaceId), eq(executionWorkspaces.companyId, restorePoint.companyId),
        sql`${executionWorkspaces.metadata}->${key} = ${JSON.stringify(recipe)}::jsonb`))
        .returning({ id: executionWorkspaces.id });
      settled = updated.length === 1;
    }
    if (!settled) throw new RestorePointRestoreFailure("restore_point_expiry_conflict");
  }
}
