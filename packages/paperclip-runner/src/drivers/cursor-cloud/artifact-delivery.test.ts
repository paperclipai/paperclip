import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stageCursorCloudArtifact } from "./artifact-delivery.js";
import { reserveCursorCloudArtifactStaging } from "./artifact-staging-budget.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), link: vi.fn(original.link), unlink: vi.fn(original.unlink) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp("/tmp/cc-artifact-"); roots.push(root);
  const bytes = Buffer.from("downloaded provider result\n"); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const client = { listArtifacts: vi.fn(async () => ({ items: [{ path: "artifacts/result.txt", sizeBytes: bytes.length, updatedAt: "2026-10-28" }] })), downloadArtifact: vi.fn(async () => bytes) };
  const args = { contentRef: "cursor-artifact:artifacts/result.txt", filename: "result.txt", byteSize: bytes.length, sha256, contentType: "text/plain" };
  const controller = new AbortController(); const artifactRoot = join(root, "artifacts"); const directory = join(artifactRoot, sha256);
  const input = { arguments: args, agentId: "agent", runtimeDirectory: root, artifactRoot, client, signal: controller.signal };
  return { root, bytes, args, input, controller, directory, target: join(directory, args.filename), normalized: { ...args, contentRef: join(sha256, args.filename) } };
}

async function postLinkWriter(f: Awaited<ReturnType<typeof fixture>>) {
  const script = join(f.root, `postlink-${randomUUID()}.mjs`);
  await writeFile(script, `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.link;
    fs.link = async (...args) => {
      await original(...args); process.send({ name: "linked", temporary: args[0] });
      await new Promise(resolve => process.once("message", resolve));
    };
    syncBuiltinESMExports();
    const { stageCursorCloudArtifact } = await import(${JSON.stringify(new URL("./artifact-delivery.ts", import.meta.url).href)});
    const bytes = Buffer.from(${JSON.stringify(f.bytes.toString("base64"))}, "base64");
    const result = await stageCursorCloudArtifact({ arguments: ${JSON.stringify(f.args)}, agentId: "agent", runtimeDirectory: ${JSON.stringify(f.root)}, artifactRoot: ${JSON.stringify(f.input.artifactRoot)},
      client: { listArtifacts: async () => ({ items: [{ path: "artifacts/result.txt", sizeBytes: bytes.length }] }), downloadArtifact: async () => bytes }, signal: new AbortController().signal });
    process.send({ name: "completed", result }, () => process.disconnect());
  `, { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, script], { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", bytes => { stderr = (stderr + bytes).slice(-4_096); });
  const exited = once(child, "exit");
  try {
    const message = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`postlink fixture exited early: ${stderr}`); })]);
    expect(message[0]).toMatchObject({ name: "linked" });
    const temporary = String(message[0].temporary);
    expect(await readFile(temporary)).toEqual(f.bytes);
    return { child, exited, temporary, async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    } };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited; throw error;
  }
}

function exitedPid() {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", ""], { env: {}, stdio: "ignore" });
  expect(child.status).toBe(0);
  expect(() => process.kill(child.pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
  return child.pid;
}

function aliasPath(f: Awaited<ReturnType<typeof fixture>>, pid: number, filename = f.args.filename) {
  const targetDigest = createHash("sha256").update(filename).digest("hex");
  return join(f.directory, `.cursor-cloud-${targetDigest}-${pid}-${randomUUID()}-${randomUUID()}.tmp`);
}

describe("Cursor Cloud artifact registration boundary", () => {
  it("recovers an exact published final at capacity without a new allocation", async () => {
    const f = await fixture(); const writer = await postLinkWriter(f);
    try {
      await writer.stop();
      for (let count = 1; count < 256; count++) await reserveCursorCloudArtifactStaging({ ...f.input, byteSize: 0 });
      const budgetPath = join(f.root, ".artifact-staging-budget", "usage.json");
      const before = await readFile(budgetPath, "utf8");
      expect(JSON.parse(before).allocations).toBe(256);
      expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
      expect((await lstat(f.target)).nlink).toBe(1);
      expect(await readFile(budgetPath, "utf8")).toBe(before);
      expect(f.input.client.downloadArtifact).toHaveBeenCalledOnce();
      await expect(stageCursorCloudArtifact({ ...f.input, arguments: { ...f.args, filename: "over-budget.txt" } })).rejects.toThrow(/staging budget/);
      expect(f.input.client.downloadArtifact).toHaveBeenCalledOnce();
    } finally { await writer.stop(); }
  }, 20_000);

  it("rejects changed current provider bytes despite a matching verified cached final", async () => {
    const f = await fixture(); await stageCursorCloudArtifact(f.input);
    f.input.client.downloadArtifact.mockResolvedValueOnce(Buffer.alloc(f.bytes.length, "x"));
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow("do not match");
    expect(await readFile(f.target)).toEqual(f.bytes);
  });

  it("refuses cached bytes that grow after their initial size observation", async () => {
    const f = await fixture(); await stageCursorCloudArtifact(f.input);
    f.input.client.downloadArtifact.mockClear();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let injected = false;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      if (!injected && String(path) === f.target) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async () => {
          const before = await stat();
          if (!injected) { injected = true; await writeFile(f.target, Buffer.concat([f.bytes, Buffer.from("extra")])); }
          return before;
        });
      }
      return handle;
    }) as typeof open);
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow("identity conflict");
    expect(f.input.client.downloadArtifact).not.toHaveBeenCalled();
    expect((await lstat(f.target)).size).toBe(f.bytes.length + 5);
  });

  it("refuses a new download after legacy retained bytes reach the 256 MiB budget", async () => {
    const f = await fixture();
    const size = 16_777_216, hash = createHash("sha256").update(Buffer.alloc(size)).digest("hex");
    const directory = join(f.input.artifactRoot, hash); await mkdir(directory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 16; index++) {
      const file = await open(join(directory, `legacy-${index}`), "wx", 0o600);
      try { await file.truncate(size); } finally { await file.close(); }
    }
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow(/staging budget/);
    expect(f.input.client.downloadArtifact).not.toHaveBeenCalled();
    await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toHaveLength(16);
  });

  it("counts zero-byte retained files against the 256-allocation budget", async () => {
    const f = await fixture(); const hash = createHash("sha256").update("").digest("hex");
    const directory = join(f.input.artifactRoot, hash); await mkdir(directory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 256; index++) await writeFile(join(directory, `legacy-${index}`), "", { mode: 0o600 });
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow(/staging budget/);
    expect(f.input.client.downloadArtifact).not.toHaveBeenCalled();
    expect(await readdir(directory)).toHaveLength(256);
  });

  it("recovers an actual postlink writer crash to one final link", async () => {
    const f = await fixture(); const writer = await postLinkWriter(f);
    try {
      const published = await lstat(f.target); expect(published.nlink).toBe(2);
      await writer.stop();
      expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
      const recovered = await lstat(f.target);
      expect([recovered.dev, recovered.ino, recovered.nlink]).toEqual([published.dev, published.ino, 1]);
      expect(await readFile(f.target)).toEqual(f.bytes);
      await expect(lstat(writer.temporary)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(f.directory)).toEqual([f.args.filename]);
    } finally { await writer.stop(); }
  });

  it("lets concurrent retries adopt one dead publisher alias without replacing the final", async () => {
    const f = await fixture(); const writer = await postLinkWriter(f);
    try {
      await writer.stop(); const published = await lstat(f.target);
      const foreign = join(f.directory, "unrelated-private-file");
      await writeFile(foreign, "retained foreign bytes", { mode: 0o600 }); const before = await lstat(foreign);
      expect(await Promise.all([stageCursorCloudArtifact(f.input), stageCursorCloudArtifact(f.input)])).toEqual([f.normalized, f.normalized]);
      const recovered = await lstat(f.target); const retained = await lstat(foreign);
      expect([recovered.dev, recovered.ino, recovered.nlink]).toEqual([published.dev, published.ino, 1]);
      expect([retained.dev, retained.ino, retained.mode]).toEqual([before.dev, before.ino, before.mode]);
      expect(await readFile(f.target)).toEqual(f.bytes);
      expect(await readFile(foreign, "utf8")).toBe("retained foreign bytes");
      await expect(lstat(writer.temporary)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(f.directory)).sort()).toEqual([f.args.filename, "unrelated-private-file"].sort());
    } finally { await writer.stop(); }
  });

  it("never removes another live process's published alias", async () => {
    const f = await fixture(); const writer = await postLinkWriter(f);
    try {
      const before = await lstat(writer.temporary);
      await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow();
      const retained = await lstat(writer.temporary);
      expect([retained.dev, retained.ino, retained.nlink]).toEqual([before.dev, before.ino, 2]);
      expect(await readFile(writer.temporary)).toEqual(f.bytes);
      const completed = once(writer.child, "message"); writer.child.send("continue");
      expect((await completed)[0]).toMatchObject({ name: "completed", result: f.normalized });
      expect(await writer.exited).toEqual([0, null]);
      expect((await lstat(f.target)).nlink).toBe(1);
      expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
    } finally { await writer.stop(); }
  });

  it("never removes an active same-module publisher alias", async () => {
    const f = await fixture(); const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const linked = deferred(); const resume = deferred(); let alias = "";
    vi.mocked(link).mockImplementation(async (source, destination) => {
      await original.link(source, destination);
      if (!alias && String(destination) === f.target) { alias = String(source); linked.resolve(); await resume.promise; }
    });
    const active = stageCursorCloudArtifact(f.input);
    try {
      await linked.promise;
      const before = await lstat(alias);
      await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow();
      const retained = await lstat(alias);
      expect([retained.dev, retained.ino, retained.nlink]).toEqual([before.dev, before.ino, 2]);
      expect(await readFile(alias)).toEqual(f.bytes);
      resume.resolve(); expect(await active).toEqual(f.normalized);
      expect((await lstat(f.target)).nlink).toBe(1);
      expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
    } finally { resume.resolve(); await active.catch(() => {}); }
  });

  it("recovers only the alias of a finished own attempt after cleanup failure", async () => {
    const f = await fixture(); const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let alias = "";
    vi.mocked(unlink).mockImplementation(async path => {
      if (!alias && String(path).startsWith(`${f.directory}/`) && String(path).endsWith(".tmp")) {
        alias = String(path); throw Object.assign(new Error("fixture completed-attempt cleanup failed"), { code: "EIO" });
      }
      await original.unlink(path);
    });
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow("fixture completed-attempt cleanup failed");
    expect((await lstat(f.target)).nlink).toBe(2);
    expect(await readFile(alias)).toEqual(f.bytes);
    expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
    await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(f.target)).nlink).toBe(1);
    expect(await readdir(f.directory)).toEqual([f.args.filename]);
  });

  it.each(["foreign", "unknown", "wrong-target", "live-reused-pid", "malformed", "unrelated-inode", "symlink", "unknown-liveness"])("retains %s aliases and refuses to certify multiple links", async mode => {
    const f = await fixture(); let ownSuccessfulAlias = "";
    if (mode === "foreign") {
      const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(link).mockImplementation(async (source, destination) => {
        await original.link(source, destination);
        if (!ownSuccessfulAlias && String(destination) === f.target) ownSuccessfulAlias = String(source);
      });
    }
    await stageCursorCloudArtifact(f.input);
    const deadPid = exitedPid(); const originalKill = process.kill.bind(process);
    let alias = mode === "foreign" ? ownSuccessfulAlias
      : mode === "unknown" ? join(f.directory, `.cursor-cloud-${randomUUID()}.tmp`)
      : aliasPath(f, mode === "live-reused-pid" ? process.pid : deadPid, mode === "wrong-target" ? "other-result.txt" : f.args.filename);
    if (mode === "malformed") alias = alias.replace(/-[a-f0-9-]{36}\.tmp$/, "-not-an-attempt.tmp");
    if (mode === "unrelated-inode" || mode === "symlink") {
      await link(f.target, join(f.directory, "unknown-final-alias"));
      if (mode === "unrelated-inode") await writeFile(alias, f.bytes, { mode: 0o600 });
      else await symlink(f.target, alias);
    } else await link(f.target, alias);
    if (mode === "unknown-liveness") vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === deadPid) throw Object.assign(new Error("fixture owner liveness unknown"), { code: "EPERM" });
      return originalKill(pid, signal);
    });
    const before = await lstat(alias); const final = await lstat(f.target); const names = (await readdir(f.directory)).sort();
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow();
    const after = await lstat(alias); const retained = await lstat(f.target);
    expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
    expect([retained.dev, retained.ino, retained.nlink]).toEqual([final.dev, final.ino, 2]);
    expect(await readFile(alias)).toEqual(f.bytes);
    expect(await readFile(f.target)).toEqual(f.bytes);
    expect((await readdir(f.directory)).sort()).toEqual(names);
  });

  it.each(["entries", "aliases"])("refuses an over-bound %s recovery without deleting aliases", async mode => {
    const f = await fixture(); await stageCursorCloudArtifact(f.input); const deadPid = exitedPid();
    const aliases = Array.from({ length: mode === "aliases" ? 33 : 1 }, () => aliasPath(f, deadPid));
    for (const alias of aliases) await link(f.target, alias);
    if (mode === "entries") for (let index = 0; index < 256; index += 16) {
      await Promise.all(Array.from({ length: 16 }, (_, offset) => writeFile(join(f.directory, `unrelated-${index + offset}`), "retained", { mode: 0o600 })));
    }
    const before = await lstat(f.target); const names = (await readdir(f.directory)).sort();
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow();
    const after = await lstat(f.target);
    expect([after.dev, after.ino, after.nlink]).toEqual([before.dev, before.ino, before.nlink]);
    expect((await readdir(f.directory)).sort()).toEqual(names);
    for (const alias of aliases) expect(await readFile(alias)).toEqual(f.bytes);
  });

  it("does not clean a dead publisher alias after recovery cancellation", async () => {
    const f = await fixture(); const writer = await postLinkWriter(f); await writer.stop();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      if (String(path) === f.target) {
        const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof handle.read>>>;
        vi.spyOn(handle, "read").mockImplementation((async (...args: unknown[]) => {
          const bytes = await read(...args); f.controller.abort(new Error("fixture artifact recovery cancelled")); return bytes;
        }) as typeof handle.read);
      }
      return handle;
    }) as typeof open);
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow("fixture artifact recovery cancelled");
    expect(await readFile(writer.temporary)).toEqual(f.bytes);
    expect((await lstat(f.target)).nlink).toBe(2);
    vi.mocked(open).mockImplementation(original.open);
    expect(await stageCursorCloudArtifact({ ...f.input, signal: new AbortController().signal })).toEqual(f.normalized);
    expect((await lstat(f.target)).nlink).toBe(1);
  });

  it("never exposes a partial final file and allows retry after a failed write", async () => {
    const f = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const partial = deferred(); const resume = deferred(); let injected = false;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      if (!injected && String(path).startsWith(`${f.directory}/`) && (flags === "wx" || (typeof flags === "number" && (flags & constants.O_EXCL) !== 0))) {
        injected = true;
        vi.spyOn(handle, "writeFile").mockImplementation(async () => {
          await handle.write(f.bytes.subarray(0, 4), 0, 4, 0);
          partial.resolve(); await resume.promise; throw new Error("fixture partial artifact write failed");
        });
      }
      return handle;
    }) as typeof open);
    const staging = stageCursorCloudArtifact(f.input);
    try {
      await partial.promise;
      const visible = await readFile(f.target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      resume.resolve();
      await expect(staging).rejects.toThrow("fixture partial artifact write failed");
      expect(visible).toBeNull();
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(f.directory)).toEqual([]);
      expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
      expect(await readFile(f.target)).toEqual(f.bytes);
    } finally { resume.resolve(); await staging.catch(() => {}); }
  });

  it("does not publish an artifact cancelled while its private write is pending", async () => {
    const f = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const written = deferred(); const resume = deferred(); let injected = false;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      if (!injected && String(path).startsWith(`${f.directory}/`) && (flags === "wx" || (typeof flags === "number" && (flags & constants.O_EXCL) !== 0))) {
        injected = true; const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async (...args) => { await write(...args); written.resolve(); await resume.promise; });
      }
      return handle;
    }) as typeof open);
    const staging = stageCursorCloudArtifact(f.input);
    try {
      await written.promise; f.controller.abort(new Error("fixture artifact cancellation")); resume.resolve();
      await expect(staging).rejects.toThrow("fixture artifact cancellation");
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(f.directory)).toEqual([]);
      expect(JSON.parse(await readFile(join(f.root, ".artifact-staging-budget", "usage.json"), "utf8")).allocations).toBe(1);
    } finally { resume.resolve(); await staging.catch(() => {}); }
  });

  it("keeps the final absent through an actual writer crash and retries without reaping the orphan", async () => {
    const f = await fixture();
    const script = join(f.root, "crash-writer.mjs");
    await writeFile(script, `
      import fs from "node:fs/promises";
      import { constants } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.open;
      fs.open = async (...args) => {
        const handle = await original(...args);
        const flags = args[1];
        if (String(args[0]).startsWith(${JSON.stringify(`${f.directory}/`)}) && (flags === "wx" || (typeof flags === "number" && (flags & constants.O_EXCL) !== 0))) {
          handle.writeFile = async bytes => {
            await handle.write(bytes.subarray(0, 4), 0, 4, 0); await handle.sync();
            process.send("partial-written");
            await new Promise(resolve => process.once("message", resolve));
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      const { stageCursorCloudArtifact } = await import(${JSON.stringify(new URL("./artifact-delivery.ts", import.meta.url).href)});
      const bytes = Buffer.from(${JSON.stringify(f.bytes.toString("base64"))}, "base64");
      await stageCursorCloudArtifact({ arguments: ${JSON.stringify(f.args)}, agentId: "agent", runtimeDirectory: ${JSON.stringify(f.root)}, artifactRoot: ${JSON.stringify(f.input.artifactRoot)},
        client: { listArtifacts: async () => ({ items: [{ path: "artifacts/result.txt", sizeBytes: bytes.length }] }), downloadArtifact: async () => bytes }, signal: new AbortController().signal });
      process.send("unexpected-completed");
    `, { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, script], { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr?.on("data", bytes => { stderr = (stderr + bytes).slice(-4_096); });
    const exited = once(child, "exit");
    try {
      const message = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`artifact crash fixture exited early: ${stderr}`); })]);
      expect(message[0]).toBe("partial-written");
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      child.kill("SIGKILL"); expect(await exited).toEqual([null, "SIGKILL"]);
      const orphans = await readdir(f.directory);
      expect(orphans).toHaveLength(1);
      const orphan = join(f.directory, orphans[0]!);
      expect(await readFile(orphan)).toEqual(f.bytes.subarray(0, 4));
      expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
      expect(await readFile(f.target)).toEqual(f.bytes);
      expect(await readFile(orphan)).toEqual(f.bytes.subarray(0, 4));
      expect((await readdir(f.directory)).sort()).toEqual([...orphans, f.args.filename].sort());
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("concurrently stages identical bytes without replacing the first verified final", async () => {
    const f = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const written = deferred(); const resume = deferred(); let held = false;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      if (!held && String(path).startsWith(`${f.directory}/`) && (flags === "wx" || (typeof flags === "number" && (flags & constants.O_EXCL) !== 0))) {
        held = true; const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async (...args) => { await write(...args); written.resolve(); await resume.promise; });
      }
      return handle;
    }) as typeof open);
    const first = stageCursorCloudArtifact(f.input);
    try {
      await written.promise;
      expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
      const published = await lstat(f.target);
      resume.resolve(); expect(await first).toEqual(f.normalized);
      const retained = await lstat(f.target);
      expect([retained.dev, retained.ino]).toEqual([published.dev, published.ino]);
      expect(await readFile(f.target)).toEqual(f.bytes);
      expect(await readdir(f.directory)).toEqual([f.args.filename]);
    } finally { resume.resolve(); await first.catch(() => {}); }
  });

  it("requires directory sync again when retry verifies an already-published final", async () => {
    const f = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const synced: string[] = []; let failures = 2;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      if ([f.directory, f.input.artifactRoot, f.root].includes(String(path))) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          synced.push(String(path));
          if (String(path) === f.directory && failures-- > 0) throw new Error("fixture artifact directory sync failed");
          await sync();
        });
      }
      return handle;
    }) as typeof open);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow("fixture artifact directory sync failed");
      expect(await readFile(f.target)).toEqual(f.bytes);
      expect(await readdir(f.directory)).toEqual([f.args.filename]);
    }
    expect(await stageCursorCloudArtifact(f.input)).toEqual(f.normalized);
    expect(synced).toEqual([f.root, f.directory, f.directory, f.directory, f.input.artifactRoot, f.root]);
  });

  it.each(["partial", "wrong-hash", "public-mode", "symlink", "directory"])("refuses an existing %s final unchanged", async mode => {
    const f = await fixture(); await mkdir(f.directory, { recursive: true, mode: 0o700 });
    const bytes = mode === "partial" ? f.bytes.subarray(0, 4) : mode === "wrong-hash" ? Buffer.alloc(f.bytes.length, "x") : f.bytes;
    if (mode === "directory") await mkdir(f.target, { mode: 0o700 });
    else if (mode === "symlink") {
      const target = join(f.root, "unrelated-result");
      await writeFile(target, bytes, { mode: 0o600 }); await symlink(target, f.target);
    } else await writeFile(f.target, bytes, { mode: mode === "public-mode" ? 0o644 : 0o600 });
    const before = await lstat(f.target);
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow();
    const after = await lstat(f.target);
    expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
    if (mode !== "directory") expect(await readFile(f.target)).toEqual(bytes);
    expect(await readdir(f.directory)).toEqual([f.args.filename]);
  });

  it.each(["replace", "symlink"])("retains a foreign %s temporary file without publishing or deleting it", async mode => {
    const f = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let temporary = "";
    vi.mocked(open).mockImplementation((async (path, flags, fileMode) => {
      const handle = await original.open(path, flags, fileMode);
      if (String(path).startsWith(`${f.directory}/`) && typeof flags === "number" && (flags & constants.O_EXCL) !== 0) {
        temporary = String(path); const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await sync(); await rename(temporary, join(f.root, "retained-own-temporary"));
          if (mode === "replace") await writeFile(temporary, "foreign temporary", { mode: 0o600 });
          else {
            const target = join(f.root, "foreign-temporary");
            await writeFile(target, "foreign temporary", { mode: 0o600 }); await symlink(target, temporary);
          }
        });
      }
      return handle;
    }) as typeof open);
    await expect(stageCursorCloudArtifact(f.input)).rejects.toThrow("temporary ownership changed");
    expect(await readFile(temporary, "utf8")).toBe("foreign temporary");
    expect(await readFile(join(f.root, "retained-own-temporary"))).toEqual(f.bytes);
    await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    if (mode === "symlink") expect((await lstat(temporary)).isSymbolicLink()).toBe(true);
  });

  it.each(["fresh", "existing"])("stages %s verified bytes with a contentRef relative to the artifact root", async state => {
    const root = await mkdtemp("/tmp/cc-artifact-"); roots.push(root);
    const bytes = Buffer.from("downloaded provider result\n"); const sha256 = createHash("sha256").update(bytes).digest("hex");
    const client = { listArtifacts: vi.fn(async () => ({ items: [{ path: "artifacts/result.txt", sizeBytes: bytes.length, updatedAt: "2026-10-28" }] })), downloadArtifact: vi.fn(async () => bytes) };
    const args = { contentRef: "cursor-artifact:artifacts/result.txt", filename: "result.txt", byteSize: bytes.length, sha256, contentType: "text/plain" };
    const artifactRoot = join(root, "artifacts");
    const input = { arguments: args, agentId: "agent", runtimeDirectory: root, artifactRoot, client, signal: new AbortController().signal };
    if (state === "existing") await stageCursorCloudArtifact(input);
    const normalized = await stageCursorCloudArtifact(input);
    expect(normalized).toEqual({ ...args, contentRef: join(sha256, "result.txt") });
    expect(await readFile(join(artifactRoot, normalized.contentRef as string))).toEqual(bytes);
    await expect(stageCursorCloudArtifact({ arguments: { ...args, sha256: "a".repeat(64) }, agentId: "agent", runtimeDirectory: root, artifactRoot: join(root, "artifacts"), client, signal: new AbortController().signal })).rejects.toThrow("do not match");
  });
  it("rejects host paths, traversal, unlisted paths, size mismatches and an unadmitted root", async () => {
    const root = await mkdtemp("/tmp/cc-artifact-"); roots.push(root);
    const client = { listArtifacts: vi.fn(async () => ({ items: [] })), downloadArtifact: vi.fn(async () => Buffer.from("not read")) };
    const input = { agentId: "agent", runtimeDirectory: root, artifactRoot: join(root, "artifacts"), client, signal: new AbortController().signal };
    for (const contentRef of ["/etc/passwd", "cursor-artifact:../outside", "cursor-artifact:artifacts/missing"]) {
      await expect(stageCursorCloudArtifact({ ...input, arguments: { contentRef, filename: "file", byteSize: 1, sha256: "a".repeat(64) } })).rejects.toThrow();
    }
    await expect(stageCursorCloudArtifact({ ...input, artifactRoot: root, arguments: { contentRef: "cursor-artifact:artifacts/file", filename: "file", byteSize: 1, sha256: "a".repeat(64) } })).rejects.toThrow("outside");
    expect(client.downloadArtifact).not.toHaveBeenCalled();
  });
});
