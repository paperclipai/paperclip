import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { semanticCanonicalJson } from "../semantic-tool-receipt.js";
import { parseCursorCloudBinding, type CursorCloudBinding } from "./config.js";
import { releaseCursorCloudStaleSocket } from "./stale-socket.js";

export const cursorCloudDigest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface CursorCloudTerminalDelivery {
  schema: "paperclip.cursor-cloud.terminal-delivery.v1";
  threadId: string;
  turnId: string;
  providerRunId: string;
  receiptId: string;
  status: "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
  interrupted: boolean;
  result: string | null;
}

export interface CursorCloudCheckpoint {
  schema: "paperclip.cursor-cloud.checkpoint.v1";
  driverSessionId: string;
  normalizedSessionId: string;
  bindingDigest: string;
  configDigest: string;
  modelDigest: string;
  instructionsDigest: string;
  instructionsRevisionPending: boolean;
  ownerRunId: string;
  agentId: string | null;
  runId: string | null;
  turnId: string | null;
  relayTurnToken?: string | null;
  phase: "idle" | "creating" | "running" | "stopping" | "terminal";
  pendingOperation: "create_agent" | "create_run" | null;
  idempotencyKey: string | null;
  requestedAgentId: string | null;
  requestDigest: string | null;
  lastEventId: string | null;
  lastEventFingerprints: string[];
  sourceSequence: number;
  terminalStatus: string | null;
  deadlineAt: number | null;
  pendingTerminalDelivery: CursorCloudTerminalDelivery | null;
  acceptedCompletion: { callIdDigest: string; inputDigest: string; resultDigest: string; turnId: string } | null;
}

export class CursorCloudCheckpointStore {
  readonly path: string;
  readonly #lockPath: string;
  readonly #root: string;
  #lockToken: string | null = null;
  #lockIdentity: { dev: number; ino: number } | null = null;
  recoveredDeadOwner = false;
  #writes: Promise<void> = Promise.resolve();

  constructor(root: string, sessionId: string) {
    if (!isAbsolute(root) || !sessionId || sessionId.length > 1_024) throw new Error("Cursor Cloud checkpoint requires a private absolute directory and session identity");
    this.#root = root;
    this.path = join(root, `checkpoint-${cursorCloudDigest(sessionId)}.json`);
    this.#lockPath = `${this.path}.lock`;
  }

  async acquire(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.#root);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || (process.getuid && root.uid !== process.getuid())) throw new Error("Cursor Cloud runtime directory must be owned and private (0700)");
    const token = randomUUID();
    const guardPath = `${this.#lockPath}.acquire`;
    let guard;
    try { guard = await open(guardPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Cursor Cloud checkpoint acquisition is in progress or ambiguous");
      throw error;
    }
    try {
      const held = await guard.stat();
      await guard.writeFile(JSON.stringify({ pid: process.pid, token })); await guard.sync();
      try {
        // Serialize the complete stale-lock decision and replacement, not just unlink.
        // An abandoned guard is uncertainty: never recursively take over another guard.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const handle = await open(this.#lockPath, "wx", 0o600);
            let identity;
            try { identity = await handle.stat(); await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
            finally { await handle.close(); }
            this.#lockIdentity = { dev: identity.dev, ino: identity.ino };
            this.#lockToken = token;
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt !== 0) throw new Error("Cursor Cloud session already has an owner");
            const before = await lstat(this.#lockPath);
            if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) throw new Error("Cursor Cloud checkpoint ownership is unsafe");
            let owner: { pid?: unknown };
            try { owner = JSON.parse(await readFile(this.#lockPath, "utf8")); }
            catch { throw new Error("Cursor Cloud checkpoint owner is unknown"); }
            if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) throw new Error("Cursor Cloud checkpoint owner is unknown");
            try { process.kill(Number(owner.pid), 0); throw new Error("Cursor Cloud session already has a live owner"); }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
            const current = await lstat(this.#lockPath);
            if (current.ino !== before.ino || current.dev !== before.dev) throw new Error("Cursor Cloud checkpoint owner changed");
            await unlink(this.#lockPath);
            this.recoveredDeadOwner = true;
          }
        }
      } finally {
        let current;
        try {
          current = await open(guardPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const stat = await current.stat();
          if (!stat.isFile() || stat.dev !== held.dev || stat.ino !== held.ino || (stat.mode & 0o077) !== 0
            || (process.getuid && stat.uid !== process.getuid()) || stat.size > 1_024) throw new Error("Cursor Cloud checkpoint acquisition ownership changed");
          const owner = JSON.parse(await current.readFile("utf8"));
          if (owner.pid !== process.pid || owner.token !== token) throw new Error("Cursor Cloud checkpoint acquisition ownership changed");
        } catch { throw new Error("Cursor Cloud checkpoint acquisition ownership changed"); }
        finally { await current?.close(); }
        await unlink(guardPath);
      }
    } finally { await guard.close(); }
  }

  async read(): Promise<CursorCloudCheckpoint | null> {
    let handle;
    try { handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 524_288) throw new Error("Cursor Cloud checkpoint is unsafe or exceeds its bound");
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Cursor Cloud checkpoint");
      const cp = value as CursorCloudCheckpoint;
      if (cp.deadlineAt === undefined) cp.deadlineAt = ["creating", "running", "stopping"].includes(cp.phase) ? 0 : null;
      if (cp.pendingTerminalDelivery === undefined) cp.pendingTerminalDelivery = null;
      if (cp.instructionsRevisionPending === undefined) cp.instructionsRevisionPending = false;
      if (cp.relayTurnToken === undefined) cp.relayTurnToken = null;
      const digestFields = [cp.bindingDigest, cp.configDigest, cp.modelDigest, cp.instructionsDigest];
      if (cp.schema !== "paperclip.cursor-cloud.checkpoint.v1" || !digestFields.every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
        || !["idle", "creating", "running", "stopping", "terminal"].includes(cp.phase)
        || !Number.isSafeInteger(cp.sourceSequence) || cp.sourceSequence < 0
        || typeof cp.instructionsRevisionPending !== "boolean"
        || (cp.relayTurnToken !== null && (typeof cp.relayTurnToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cp.relayTurnToken)))
        || (cp.deadlineAt !== null && (!Number.isSafeInteger(cp.deadlineAt) || cp.deadlineAt < 0))
        || !Array.isArray(cp.lastEventFingerprints) || cp.lastEventFingerprints.length > 32
        || !cp.lastEventFingerprints.every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
        || ![cp.driverSessionId, cp.normalizedSessionId, cp.ownerRunId].every(v => typeof v === "string" && v.length > 0 && v.length <= 1_024)
        || ![cp.agentId, cp.runId, cp.turnId, cp.idempotencyKey, cp.requestedAgentId, cp.requestDigest, cp.lastEventId, cp.terminalStatus].every(v => v === null || (typeof v === "string" && v.length <= 1_024))
        || ![null, "create_agent", "create_run"].includes(cp.pendingOperation)) throw new Error("Invalid Cursor Cloud checkpoint");
      const pending = cp.pendingTerminalDelivery;
      if (pending !== null && (typeof pending !== "object" || Array.isArray(pending)
        || pending.schema !== "paperclip.cursor-cloud.terminal-delivery.v1" || pending.threadId !== cp.driverSessionId
        || pending.turnId !== cp.turnId || pending.providerRunId !== cp.runId
        || typeof pending.receiptId !== "string" || !/^[a-f0-9-]{36}$/.test(pending.receiptId)
        || !["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(pending.status)
        || typeof pending.interrupted !== "boolean" || (pending.result !== null && (typeof pending.result !== "string" || pending.result.length > 65_536)))) throw new Error("Invalid Cursor Cloud terminal delivery");
      return cp;
    } finally { await handle.close(); }
  }

  write(value: CursorCloudCheckpoint): Promise<void> {
    if (!this.#lockToken) return Promise.reject(new Error("Cursor Cloud checkpoint has no owner"));
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 524_288) return Promise.reject(new Error("Cursor Cloud checkpoint exceeds its bound"));
    const operation = this.#writes.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      try {
        await rename(temporary, this.path);
        const directory = await open(this.#root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.#writes = operation.catch(() => {});
    return operation;
  }

  async release(): Promise<void> {
    await this.#writes;
    if (!this.#lockToken || !this.#lockIdentity) return;
    const handle = await open(this.#lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== this.#lockIdentity.dev || stat.ino !== this.#lockIdentity.ino || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid()) || stat.size > 1_024) throw new Error("Cursor Cloud checkpoint ownership changed");
      const current = JSON.parse(await handle.readFile("utf8"));
      if (current.token !== this.#lockToken || current.pid !== process.pid) throw new Error("Cursor Cloud checkpoint ownership changed");
    } finally { await handle.close(); }
    await unlink(this.#lockPath);
    this.#lockToken = null;
    this.#lockIdentity = null;
  }
}

export async function archiveCursorCloudSessionCheckpoint(input: {
  runtimeDirectory: string;
  driverSessionId: string;
  ownerRunId: string;
  binding: CursorCloudBinding;
  socketPath: string;
  archiveDirectory: string;
}): Promise<void> {
  const binding = parseCursorCloudBinding(input.binding);
  if (!input.ownerRunId || !isAbsolute(input.archiveDirectory) || !isAbsolute(input.socketPath)) throw new Error("Cursor Cloud replacement requires exact private bindings");
  const archiveDirectory = resolve(input.archiveDirectory);
  const sessionRoot = dirname(resolve(input.runtimeDirectory));
  const archiveRelative = relative(sessionRoot, archiveDirectory);
  const escapes = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  if (!archiveRelative || escapes(archiveRelative) || !escapes(relative(resolve(input.runtimeDirectory), archiveDirectory))) {
    throw new Error("Cursor Cloud checkpoint archive must be separate state inside the admitted session root");
  }
  const store = new CursorCloudCheckpointStore(input.runtimeDirectory, input.driverSessionId);
  await store.acquire();
  try {
    const checkpoint = await store.read();
    if (!checkpoint) throw new Error("Cursor Cloud replacement checkpoint is missing");
    const bound = checkpoint.driverSessionId === input.driverSessionId && checkpoint.normalizedSessionId === binding.normalizedSessionId
      && checkpoint.ownerRunId === input.ownerRunId && checkpoint.bindingDigest === cursorCloudDigest(semanticCanonicalJson(binding));
    const pristine = checkpoint.phase === "idle" && checkpoint.agentId === null && checkpoint.runId === null && checkpoint.turnId === null && checkpoint.terminalStatus === null
      && checkpoint.sourceSequence === 0 && checkpoint.lastEventId === null && checkpoint.lastEventFingerprints.length === 0
      && checkpoint.requestedAgentId === null && checkpoint.idempotencyKey === null && checkpoint.requestDigest === null && checkpoint.acceptedCompletion === null;
    const terminal = checkpoint.phase === "terminal" && typeof checkpoint.agentId === "string" && checkpoint.agentId.length > 0
      && typeof checkpoint.runId === "string" && checkpoint.runId.length > 0 && typeof checkpoint.turnId === "string" && checkpoint.turnId.length > 0
      && ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(checkpoint.terminalStatus ?? "");
    if (!bound || (!pristine && !terminal) || checkpoint.pendingOperation !== null || checkpoint.pendingTerminalDelivery !== null || checkpoint.deadlineAt !== null) {
      throw new Error("Cursor Cloud replacement checkpoint is active, ambiguous or outside the admitted session");
    }
    await releaseCursorCloudStaleSocket(input.socketPath, store.recoveredDeadOwner);
    await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
    for (let directory = archiveDirectory; ; directory = dirname(directory)) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Cursor Cloud checkpoint archive must be owned and private (0700)");
      const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try { await handle.sync(); } finally { await handle.close(); }
      if (directory === sessionRoot) break;
    }
    const destination = join(archiveDirectory, basename(store.path));
    try { await lstat(destination); throw new Error("Cursor Cloud checkpoint archive already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(store.path, destination);
    for (const directory of [archiveDirectory, input.runtimeDirectory]) {
      const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try { await handle.sync(); } finally { await handle.close(); }
    }
  } finally { await store.release(); }
}
