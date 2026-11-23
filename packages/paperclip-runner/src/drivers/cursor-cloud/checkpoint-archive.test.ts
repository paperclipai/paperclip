import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { semanticCanonicalJson } from "../semantic-tool-receipt.js";
import { archiveCursorCloudSessionCheckpoint, CursorCloudCheckpointStore, cursorCloudDigest, type CursorCloudCheckpoint } from "./checkpoint.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, lstat: vi.fn(original.lstat), open: vi.fn(original.open) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const binding = { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId: "session" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function deadOwner() {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", ""], { env: {}, stdio: "ignore" });
  expect(child.status).toBe(0);
  expect(() => process.kill(child.pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
  return { pid: child.pid, token: "dead-owner" };
}

async function fixture(phase: "idle" | "terminal" = "terminal") {
  const root = await mkdtemp("/tmp/cc-archive-"); roots.push(root);
  const runtimeDirectory = join(root, "cursor-cloud");
  const store = new CursorCloudCheckpointStore(runtimeDirectory, "session");
  await store.acquire();
  const checkpoint: CursorCloudCheckpoint = { schema: "paperclip.cursor-cloud.checkpoint.v1", driverSessionId: "session", normalizedSessionId: "session",
    bindingDigest: cursorCloudDigest(semanticCanonicalJson(binding)), configDigest: "a".repeat(64), modelDigest: "b".repeat(64), instructionsDigest: "c".repeat(64),
    instructionsRevisionPending: false, relayTurnToken: null, ownerRunId: "owner", agentId: phase === "terminal" ? "bc-provider" : null,
    runId: phase === "terminal" ? "run-provider" : null, turnId: phase === "terminal" ? "turn-provider" : null,
    phase, pendingOperation: null, idempotencyKey: null, requestedAgentId: null, requestDigest: null, lastEventId: phase === "terminal" ? "opaque" : null, lastEventFingerprints: [],
    sourceSequence: phase === "terminal" ? 1 : 0, terminalStatus: phase === "terminal" ? "ERROR" : null, deadlineAt: null, pendingTerminalDelivery: null, acceptedCompletion: null };
  await store.write(checkpoint); await store.release();
  const input = { runtimeDirectory, driverSessionId: "session", ownerRunId: "owner", binding, socketPath: join(root, "mcp.sock"), archiveDirectory: join(root, "continuity-break", "cursor-cloud") };
  return { root, store, checkpoint, input };
}

describe("Cursor Cloud checkpoint ownership", () => {
  it.each(["", 123, "a".repeat(42), "a".repeat(44), "!".repeat(43)])("rejects malformed persisted turn capabilities (%s)", async token => {
    const f = await fixture();
    await f.store.acquire();
    try {
      await writeFile(f.store.path, JSON.stringify({ ...f.checkpoint, relayTurnToken: token }), { mode: 0o600 });
      await expect(f.store.read()).rejects.toThrow("Invalid Cursor Cloud checkpoint");
    } finally { await f.store.release(); }
  });


  it("does not let a delayed dead-owner contender unlink its successor's lock", async () => {
    const f = await fixture();
    const lockPath = `${f.store.path}.lock`;
    await writeFile(lockPath, JSON.stringify(deadOwner()), { mode: 0o600 });
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const firstChecked = deferred(); const secondChecked = deferred();
    const resumeFirst = deferred(); const resumeSecond = deferred();
    let lockReads = 0;
    vi.mocked(lstat).mockImplementation((async (path: Parameters<typeof lstat>[0], options: Parameters<typeof lstat>[1]) => {
      const stat = await original.lstat(path, options);
      if (String(path) === lockPath) {
        const read = ++lockReads;
        if (read === 2) { firstChecked.resolve(); await resumeFirst.promise; }
        if (read === 4) { secondChecked.resolve(); await resumeSecond.promise; }
      }
      return stat;
    }) as typeof lstat);
    const first = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session");
    const second = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session");
    const firstResult = first.acquire();
    let secondResult: Promise<{ acquired: boolean; error?: unknown }> | undefined;
    try {
      await firstChecked.promise;
      secondResult = second.acquire().then(() => ({ acquired: true }), error => ({ acquired: false, error }));
      await Promise.race([secondChecked.promise, secondResult]);
      resumeFirst.resolve(); await firstResult;
      const firstLock = await readFile(lockPath, "utf8");
      resumeSecond.resolve();
      expect(await secondResult).toMatchObject({ acquired: false, error: expect.objectContaining({ message: "Cursor Cloud checkpoint acquisition is in progress or ambiguous" }) });
      expect(await readFile(lockPath, "utf8")).toBe(firstLock);
      await first.write({ ...f.checkpoint, sourceSequence: 2 });
      expect((await first.read())?.sourceSequence).toBe(2);
    } finally {
      resumeFirst.resolve(); resumeSecond.resolve();
      await firstResult.catch(() => {}); await secondResult;
      await first.release().catch(() => {}); await second.release().catch(() => {});
    }
  });

  it.each(["live", "dead", "corrupt", "symlink"])("preserves a %s acquisition guard and refuses takeover and archival", async mode => {
    const f = await fixture();
    const lockPath = `${f.store.path}.lock`;
    const guardPath = `${lockPath}.acquire`;
    const lockBytes = JSON.stringify(deadOwner());
    await writeFile(lockPath, lockBytes, { mode: 0o600 });
    const guardBytes = mode === "corrupt" ? "{" : JSON.stringify(mode === "dead" ? deadOwner() : { pid: process.pid, token: "other-acquirer" });
    if (mode === "symlink") {
      const target = join(f.root, "retained-acquirer");
      await writeFile(target, guardBytes, { mode: 0o600 }); await symlink(target, guardPath);
    } else await writeFile(guardPath, guardBytes, { mode: 0o600 });
    const checkpointBytes = await readFile(f.store.path, "utf8");
    const contender = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session");
    try {
      await expect(contender.acquire()).rejects.toThrow("acquisition");
      await expect(archiveCursorCloudSessionCheckpoint(f.input)).rejects.toThrow("acquisition");
      expect(await readFile(lockPath, "utf8")).toBe(lockBytes);
      expect(await readFile(guardPath, "utf8")).toBe(guardBytes);
      expect(await readFile(f.store.path, "utf8")).toBe(checkpointBytes);
      await expect(readdir(f.input.archiveDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      if (mode === "symlink") expect((await lstat(guardPath)).isSymbolicLink()).toBe(true);
    } finally { await contender.release().catch(() => {}); }
  });

  it("automatically recovers a dead main owner and retains exclusive checkpoint and archive ownership", async () => {
    const f = await fixture(); const lockPath = `${f.store.path}.lock`;
    await writeFile(lockPath, JSON.stringify(deadOwner()), { mode: 0o600 });
    const recovered = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session");
    await recovered.acquire();
    try {
      expect(recovered.recoveredDeadOwner).toBe(true);
      expect(await recovered.read()).toEqual(f.checkpoint);
      const lockBytes = await readFile(lockPath, "utf8");
      await expect(archiveCursorCloudSessionCheckpoint(f.input)).rejects.toThrow("live owner");
      expect(await readFile(lockPath, "utf8")).toBe(lockBytes);
      await expect(lstat(`${lockPath}.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await recovered.release(); }
    await writeFile(lockPath, JSON.stringify(deadOwner()), { mode: 0o600 });
    await archiveCursorCloudSessionCheckpoint(f.input);
    expect(JSON.parse(await readFile(join(f.input.archiveDirectory, f.store.path.split("/").at(-1)!), "utf8"))).toEqual(f.checkpoint);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${lockPath}.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans its own acquisition guard when main-lock acquisition fails", async () => {
    const f = await fixture(); const lockPath = `${f.store.path}.lock`;
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      if (String(path) === lockPath && flags === "wx" && !failed) {
        failed = true; throw Object.assign(new Error("fixture main-lock failure"), { code: "EACCES" });
      }
      return original.open(path, flags, mode);
    }) as typeof open);
    const contender = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session");
    await expect(contender.acquire()).rejects.toThrow();
    await expect(lstat(`${lockPath}.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await contender.read()).toEqual(f.checkpoint);
    await contender.acquire(); await contender.release();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["replace", "rewrite", "symlink"])("does not delete an acquisition guard after %s tampering", async mode => {
    const f = await fixture(); const lockPath = `${f.store.path}.lock`; const guardPath = `${lockPath}.acquire`;
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const guardBytes = JSON.stringify({ pid: process.pid, token: "replacement-acquirer" });
    vi.mocked(open).mockImplementation((async (path, flags, fileMode) => {
      if (String(path) === lockPath && flags === "wx") {
        if (mode !== "rewrite") await rm(guardPath);
        if (mode === "symlink") {
          const target = join(f.root, "replacement-acquirer");
          await writeFile(target, guardBytes, { mode: 0o600 }); await symlink(target, guardPath);
        } else await writeFile(guardPath, guardBytes, { mode: 0o600 });
      }
      return original.open(path, flags, fileMode);
    }) as typeof open);
    const contender = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session");
    await expect(contender.acquire()).rejects.toThrow("acquisition ownership changed");
    expect(await readFile(guardPath, "utf8")).toBe(guardBytes);
    expect(await contender.read()).toEqual(f.checkpoint);
    await contender.release();
    expect(await readFile(guardPath, "utf8")).toBe(guardBytes);
    if (mode === "symlink") expect((await lstat(guardPath)).isSymbolicLink()).toBe(true);
  });

  it.each(["replace", "rewrite", "symlink"])("does not delete the main lock after %s tampering during release", async mode => {
    const f = await fixture(); const lockPath = `${f.store.path}.lock`;
    const contender = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session");
    await contender.acquire();
    const originalBytes = await readFile(lockPath, "utf8");
    const replacementBytes = mode === "rewrite" ? JSON.stringify({ pid: process.pid, token: "replacement-owner" }) : originalBytes;
    if (mode === "replace") {
      const replacementPath = `${lockPath}.replacement`;
      await writeFile(replacementPath, replacementBytes, { flag: "wx", mode: 0o600 });
      const original = await lstat(lockPath), replacement = await lstat(replacementPath);
      expect([replacement.dev, replacement.ino]).not.toEqual([original.dev, original.ino]);
      await rename(replacementPath, lockPath);
    } else {
      if (mode !== "rewrite") await rm(lockPath);
      if (mode === "symlink") {
        const target = join(f.root, "replacement-owner");
        await writeFile(target, replacementBytes, { mode: 0o600 }); await symlink(target, lockPath);
      } else await writeFile(lockPath, replacementBytes, { mode: 0o600 });
    }
    await expect(contender.release()).rejects.toThrow();
    expect(await readFile(lockPath, "utf8")).toBe(replacementBytes);
    expect(await contender.read()).toEqual(f.checkpoint);
    await expect(lstat(`${lockPath}.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
    if (mode === "symlink") expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
  });
});

describe("Cursor Cloud replacement checkpoint archive", () => {
  it.each(["idle", "terminal"] as const)("archives only the exact %s checkpoint and preserves launch and artifact state", async phase => {
    const f = await fixture(phase);
    for (const name of ["config.json", "relay-capability.json"]) await writeFile(join(f.input.runtimeDirectory, name), name, { mode: 0o600 });
    await mkdir(join(f.input.runtimeDirectory, "artifacts"), { mode: 0o700 });
    await writeFile(join(f.input.runtimeDirectory, "artifacts", "result.txt"), "retained");
    const bytes = await readFile(f.store.path, "utf8");
    await archiveCursorCloudSessionCheckpoint(f.input);
    expect(await readFile(join(f.input.archiveDirectory, f.store.path.split("/").at(-1)!), "utf8")).toBe(bytes);
    expect((await readdir(f.input.runtimeDirectory)).sort()).toEqual(["artifacts", "config.json", "relay-capability.json"]);
    for (const name of ["config.json", "relay-capability.json"]) expect(await readFile(join(f.input.runtimeDirectory, name), "utf8")).toBe(name);
    expect(await readFile(join(f.input.runtimeDirectory, "artifacts", "result.txt"), "utf8")).toBe("retained");
    const next = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session"); await next.acquire();
    try { expect(await next.read()).toBeNull(); } finally { await next.release(); }
  });

  it.each(["requestedAgentId", "idempotencyKey", "requestDigest", "acceptedCompletion"] as const)("does not archive pristine-looking idle state with retained %s evidence", async field => {
    const f = await fixture("idle");
    const checkpoint = { ...f.checkpoint, [field]: field === "acceptedCompletion"
      ? { turnId: "turn", callIdDigest: "a".repeat(64), inputDigest: "b".repeat(64), resultDigest: "c".repeat(64) } : "retained" };
    const bytes = JSON.stringify(checkpoint); await writeFile(f.store.path, bytes);
    await expect(archiveCursorCloudSessionCheckpoint(f.input)).rejects.toThrow("active, ambiguous or outside");
    expect(await readFile(f.store.path, "utf8")).toBe(bytes);
  });

  it.each(["outside", "inside", "dot-child"])("rejects an archive with %s containment", async mode => {
    const f = await fixture();
    const bytes = await readFile(f.store.path, "utf8");
    const archiveDirectory = mode === "outside" ? `${f.root}-other` : join(f.input.runtimeDirectory, mode === "inside" ? "archive" : "..archive");
    await expect(archiveCursorCloudSessionCheckpoint({ ...f.input, archiveDirectory })).rejects.toThrow("inside the admitted session root");
    expect(await readFile(f.store.path, "utf8")).toBe(bytes);
  });

  it("preserves both files when the archive destination already exists", async () => {
    const f = await fixture();
    await mkdir(f.input.archiveDirectory, { recursive: true, mode: 0o700 });
    const destination = join(f.input.archiveDirectory, f.store.path.split("/").at(-1)!);
    await writeFile(destination, "Existing archive", { mode: 0o600 });
    const bytes = await readFile(f.store.path, "utf8");
    await expect(archiveCursorCloudSessionCheckpoint(f.input)).rejects.toThrow("archive already exists");
    expect(await readFile(f.store.path, "utf8")).toBe(bytes);
    expect(await readFile(destination, "utf8")).toBe("Existing archive");
  });

  it("preserves an unknown socket path without archiving its checkpoint", async () => {
    const f = await fixture();
    await writeFile(f.input.socketPath, "Unknown owner", { mode: 0o600 });
    const bytes = await readFile(f.store.path, "utf8");
    await expect(archiveCursorCloudSessionCheckpoint(f.input)).rejects.toThrow("safe dead-owner recovery proof");
    expect(await readFile(f.store.path, "utf8")).toBe(bytes);
    expect(await readFile(f.input.socketPath, "utf8")).toBe("Unknown owner");
    await expect(readdir(f.input.archiveDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not grant replacement from a missing checkpoint", async () => {
    const f = await fixture(); await rm(f.store.path);
    await expect(archiveCursorCloudSessionCheckpoint(f.input)).rejects.toThrow("checkpoint is missing");
    await expect(readdir(f.input.archiveDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["creating", "running", "stopping", "pending-create", "terminal-debt", "deadline", "foreign-owner", "foreign-binding", "foreign-session", "nonpristine-idle", "corrupt", "live-owner", "symlink"])("retains the exact checkpoint on %s refusal", async mode => {
    const f = await fixture();
    const checkpoint = { ...f.checkpoint };
    if (["creating", "running", "stopping"].includes(mode)) checkpoint.phase = mode as CursorCloudCheckpoint["phase"];
    if (mode === "pending-create") checkpoint.pendingOperation = "create_run";
    if (mode === "terminal-debt") checkpoint.pendingTerminalDelivery = { schema: "paperclip.cursor-cloud.terminal-delivery.v1", threadId: "session", turnId: "turn-provider", providerRunId: "run-provider", receiptId: "11111111-1111-4111-8111-111111111111", status: "ERROR", interrupted: false, result: null };
    if (mode === "nonpristine-idle") Object.assign(checkpoint, { phase: "idle", agentId: null, runId: null, turnId: null, terminalStatus: null });
    if (mode === "deadline") checkpoint.deadlineAt = Date.now() + 60_000;
    if (mode === "foreign-owner") checkpoint.ownerRunId = "other-owner";
    if (mode === "foreign-binding") checkpoint.bindingDigest = "f".repeat(64);
    if (mode === "foreign-session") checkpoint.normalizedSessionId = "other-session";
    await writeFile(f.store.path, mode === "corrupt" ? "{" : JSON.stringify(checkpoint), { mode: 0o600 });
    let held: CursorCloudCheckpointStore | undefined;
    if (mode === "live-owner") { held = new CursorCloudCheckpointStore(f.input.runtimeDirectory, "session"); await held.acquire(); }
    if (mode === "symlink") { const moved = join(f.root, "retained.json"); await writeFile(moved, JSON.stringify(checkpoint)); await rm(f.store.path); await symlink(moved, f.store.path); }
    const bytes = await readFile(f.store.path, "utf8");
    try {
      await expect(archiveCursorCloudSessionCheckpoint(f.input)).rejects.toThrow();
      expect(await readFile(f.store.path, "utf8")).toBe(bytes);
      await expect(readdir(f.input.archiveDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await held?.release(); }
  });
});
