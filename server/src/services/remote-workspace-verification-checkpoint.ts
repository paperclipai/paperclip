import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaceSnapshots, type Db } from "@paperclipai/db";
import type { ImportedWorkspaceChild } from "./remote-workspace-migration-tree.js";
import type { WorkspaceSnapshotRef } from "./remote-workspace-snapshot-storage.js";

const SCHEMA = "paperclip.workspace-snapshot-verification.v1";
const KEY = "nestedImportVerification";
type Snapshot = typeof executionWorkspaceSnapshots.$inferSelect;
type Binding = { reference: WorkspaceSnapshotRef; children: ImportedWorkspaceChild[]; operationId: string; etag: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function fingerprint(namespace: string, input: Binding) {
  return createHash("sha256").update(canonical([SCHEMA, namespace, input.reference, input.children, input.operationId])).digest("hex");
}
function matches(row: Snapshot | undefined, input: Binding) {
  const ref = input.reference;
  return row && ["committed", "superseded"].includes(row.status) && row.sourceOperationId === input.operationId
    && row.companyId === ref.companyId && row.executionWorkspaceId === ref.workspaceId && row.id === ref.id
    && row.generation === ref.generation && row.objectKey === ref.objectKey && row.sha256 === ref.sha256
    && row.byteSize === ref.byteSize && row.manifestDigest === ref.manifestDigest && isDeepStrictEqual(row.key, ref.key)
    && isDeepStrictEqual(row.metadata?.importedWorkspaceChildren ?? [], input.children);
}
function scope(ref: WorkspaceSnapshotRef) {
  return and(eq(executionWorkspaceSnapshots.companyId, ref.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, ref.workspaceId),
    eq(executionWorkspaceSnapshots.id, ref.id));
}

function transientCheckpointFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof failure.code === "string" ? failure.code : failure.cause?.code;
  return typeof code === "string" && ["55P03", "57014", "40P01", "40001"].includes(code);
}

export function nestedWorkspaceVerificationCheckpoint(db: Db, namespace: string | undefined, signal?: AbortSignal) {
  if (!namespace || !/^[a-f0-9]{64}$/.test(namespace)) return undefined;
  return {
    async read(input: Binding): Promise<boolean> {
      signal?.throwIfAborted();
      try { return await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout='1s'`);
        await tx.execute(sql`set local statement_timeout='8s'`);
        const [row] = await tx.select().from(executionWorkspaceSnapshots).where(scope(input.reference));
        signal?.throwIfAborted();
        if (!matches(row, input)) return false;
        const raw = row.metadata?.[KEY];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
        const proof = raw as Record<string, unknown>;
        return Object.keys(proof).every(key => ["schema", "namespace", "fingerprint", "etag", "completedAt"].includes(key))
          && proof.schema === SCHEMA && proof.namespace === namespace && proof.fingerprint === fingerprint(namespace, input)
          && proof.etag === input.etag && typeof proof.completedAt === "string" && Number.isFinite(Date.parse(proof.completedAt));
      }, { accessMode: "read only" }); } catch (error) {
        signal?.throwIfAborted();
        if (!transientCheckpointFailure(error)) throw error;
        return false;
      }
    },
    async save(input: Binding): Promise<void> {
      signal?.throwIfAborted();
      try { await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout='1s'`);
        await tx.execute(sql`set local statement_timeout='8s'`);
        const [row] = await tx.select().from(executionWorkspaceSnapshots).where(scope(input.reference)).for("update");
        signal?.throwIfAborted();
        if (!matches(row, input)) throw new Error("nested_workspace_snapshot_changed");
        const proof = { schema: SCHEMA, namespace, fingerprint: fingerprint(namespace, input), etag: input.etag,
          completedAt: new Date().toISOString() };
        await tx.update(executionWorkspaceSnapshots).set({ metadata: { ...row.metadata, [KEY]: proof } }).where(scope(input.reference));
        signal?.throwIfAborted();
      }); } catch (error) {
        signal?.throwIfAborted();
        if (!transientCheckpointFailure(error)) throw error;
      }
    },
  };
}
