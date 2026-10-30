import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assertCapabilityLiveSessionSnapshot,
  type CapabilityLiveSessionSnapshot,
  type CapabilityLiveSessionStore,
} from "./live-session.js";

const DURABLE_STORE_SCHEMA = "paperclip.capability.live-session-checkpoint.v1" as const;

export interface CapabilityLiveSessionStoreBinding {
  sessionId: string;
  runId: string;
  companyId: string;
  actorId: string;
  taskId: string;
}

interface DurableCheckpointEnvelope {
  schema: typeof DURABLE_STORE_SCHEMA;
  binding: CapabilityLiveSessionStoreBinding;
  snapshotSha256: string;
  snapshot: CapabilityLiveSessionSnapshot;
}

export interface DurableCapabilityLiveSessionStoreOptions {
  directory: string;
  binding: CapabilityLiveSessionStoreBinding;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireIdentifier(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`capability_live_store_${name}_required`);
}

function sameBinding(
  left: CapabilityLiveSessionStoreBinding,
  right: CapabilityLiveSessionStoreBinding,
): boolean {
  return left.sessionId === right.sessionId
    && left.runId === right.runId
    && left.companyId === right.companyId
    && left.actorId === right.actorId
    && left.taskId === right.taskId;
}

/**
 * Attempt-bound, crash-safe checkpoint storage for the governed live path.
 *
 * Each replacement is written, fsynced, renamed, and followed by a directory
 * fsync. A checksum, schema check, revision check, and immutable run binding
 * make partial writes, stale writers, corrupt JSON, and cross-attempt reuse
 * fail closed rather than silently opening another provider thread.
 */
export class DurableCapabilityLiveSessionStore implements CapabilityLiveSessionStore {
  readonly #directory: string;
  readonly #binding: CapabilityLiveSessionStoreBinding;
  readonly #checkpointPath: string;

  constructor(options: DurableCapabilityLiveSessionStoreOptions) {
    this.#directory = resolve(options.directory);
    this.#binding = structuredClone(options.binding);
    for (const [name, value] of Object.entries(this.#binding)) requireIdentifier(value, name);
    const key = sha256(this.#binding.sessionId);
    this.#checkpointPath = join(this.#directory, `${key}.json`);
  }

  async load(sessionId: string): Promise<CapabilityLiveSessionSnapshot | null> {
    this.#assertSessionId(sessionId);
    let raw: string;
    try {
      raw = await readFile(this.#checkpointPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let envelope: DurableCheckpointEnvelope;
    try {
      envelope = JSON.parse(raw) as DurableCheckpointEnvelope;
    } catch {
      throw new Error("capability_live_checkpoint_corrupt: invalid JSON");
    }
    if (envelope.schema !== DURABLE_STORE_SCHEMA) {
      throw new Error("capability_live_checkpoint_corrupt: unsupported envelope schema");
    }
    if (!sameBinding(envelope.binding, this.#binding)) {
      throw new Error("capability_live_checkpoint_binding_mismatch");
    }
    assertCapabilityLiveSessionSnapshot(envelope.snapshot);
    const serialized = JSON.stringify(envelope.snapshot);
    if (sha256(serialized) !== envelope.snapshotSha256) {
      throw new Error("capability_live_checkpoint_corrupt: checksum mismatch");
    }
    this.#assertSnapshotBinding(envelope.snapshot);
    return structuredClone(envelope.snapshot);
  }

  async save(snapshot: CapabilityLiveSessionSnapshot): Promise<void> {
    assertCapabilityLiveSessionSnapshot(snapshot);
    this.#assertSnapshotBinding(snapshot);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });

    const current = await this.load(snapshot.sessionId);
    if (current !== null) {
      if (current.revision > snapshot.revision) {
        throw new Error("capability_live_checkpoint_stale_revision");
      }
      if (current.revision === snapshot.revision) {
        if (JSON.stringify(current) === JSON.stringify(snapshot)) return;
        throw new Error("capability_live_checkpoint_revision_conflict");
      }
    }

    const serialized = JSON.stringify(snapshot);
    const envelope: DurableCheckpointEnvelope = {
      schema: DURABLE_STORE_SCHEMA,
      binding: structuredClone(this.#binding),
      snapshotSha256: sha256(serialized),
      snapshot: structuredClone(snapshot),
    };
    const temporaryPath = `${this.#checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, this.#checkpointPath);
      const directory = await open(this.#directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.#assertSessionId(sessionId);
    await unlink(this.#checkpointPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  #assertSessionId(sessionId: string): void {
    if (sessionId !== this.#binding.sessionId) {
      throw new Error("capability_live_checkpoint_binding_mismatch");
    }
  }

  #assertSnapshotBinding(snapshot: CapabilityLiveSessionSnapshot): void {
    const authority = snapshot.authority;
    const actual: CapabilityLiveSessionStoreBinding = {
      sessionId: snapshot.sessionId,
      runId: authority.runId,
      companyId: authority.companyId,
      actorId: authority.actorId,
      taskId: authority.taskId,
    };
    if (!sameBinding(actual, this.#binding)) {
      throw new Error("capability_live_checkpoint_binding_mismatch");
    }
  }
}
