import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { remoteProgram } from "./remote-program.js";
import { afterEach, describe, it, expect, vi } from "vitest";
import { boatBackend, createBoatTransportAdmission, desktopReadinessProgram, processProgram, runnerPortInventoryProgram } from "./boat.js";
import { buildGitAuthInvocation } from "../../../services/git-credentials.js";
import type { ComputerRecord } from "../domain/ledger.js";
const sshFactory = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/ssh", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>(),
  createSshCommandManagedRuntimeRunner: sshFactory,
}));
const record: ComputerRecord = {
  id: "computer",
  companyId: "company",
  environmentId: "environment",
  providerId: "bx_test",
  ledger: {
    controllerId: "controller",
    status: "attached",
    secretRef: { type: "secret_ref", secretId: "secret" },
    owners: [],
    placements: {},
    action: null,
  },
};
const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
describe("Boat transport validation", () => {
  it("uses only the file budget remaining after transport preparation", async () => {
    let clock = 1_000_000;
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const scoped = { ...record, id: randomUUID(), providerId: `bx_${randomUUID()}` };
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "", timedOut: false, signal: null, pid: null, startedAt: "" }));
    sshFactory.mockReturnValue({ execute });
    const backend = boatBackend(async () => "fixture", vi.fn(async () => {
      clock += 90_000;
      return json({ hostKey: "ssh-ed25519 AAAA", sshEndpoint: "fixture.invalid:2222" });
    }));
    try {
      await backend.remote(scoped, { action: "read", path: "AGENTS.md" }, { deadlineMs: 1_120_000 });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        command: "timeout", args: expect.arrayContaining(["--signal=KILL", "30s", "python3"]), timeoutMs: 30_000,
      }));
      clock = 1_120_000;
      await expect(backend.remote(scoped, { action: "write" }, { deadlineMs: clock })).rejects.toThrow("timed out");
      expect(execute).toHaveBeenCalledOnce();
    } finally { time.mockRestore(); sshFactory.mockReset(); }
  });
  it("kills the remote Python group at the file deadline, independent of SSH closure", async () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "boat-file-deadline-")));
    const lateWrite = join(temp, "late-write");
    let pid: number | undefined;
    const scoped = { ...record, id: randomUUID(), providerId: `bx_${randomUUID()}` };
    const execute = vi.fn(async (input: { command: string; args: string[]; stdin?: string }) => {
      expect(input.command).toBe("timeout");
      const args = [...input.args];
      args[args.length - 1] = `import os,time;print(os.getpid(),flush=True);time.sleep(2);open(${JSON.stringify(lateWrite)},'w').write('late')`;
      const result = spawnSync(input.command, args, { encoding: "utf8", input: input.stdin });
      pid = Number(result.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: false, signal: result.signal, pid: null, startedAt: "" };
    });
    sshFactory.mockReturnValue({ execute });
    const backend = boatBackend(async () => "fixture", vi.fn(async () => json({ hostKey: "ssh-ed25519 AAAA", sshEndpoint: "fixture.invalid:2222" })));
    try {
      await expect(backend.remote(scoped, { action: "read" }, { deadlineMs: Date.now() + 300 })).rejects.toThrow("Computer operation failed");
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 2000 });
      expect(existsSync(lateWrite)).toBe(false);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      sshFactory.mockReset();
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it("expires only the file waiter while shared SSH initialization remains usable", async () => {
    vi.useFakeTimers();
    const scoped = { ...record, id: randomUUID(), providerId: `bx_${randomUUID()}` };
    let initialized!: () => void;
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "", timedOut: false, signal: null, pid: null, startedAt: "" }));
    sshFactory.mockReturnValue({ execute });
    const fetcher = vi.fn(() => new Promise<Response>(resolve => {
      initialized = () => resolve(json({ hostKey: "ssh-ed25519 AAAA", sshEndpoint: "fixture.invalid:2222" }));
    }));
    const backend = boatBackend(async () => "fixture", fetcher);
    try {
      const short = backend.remote(scoped, { action: "read" }, { deadlineMs: Date.now() + 20 });
      const failure = expect(short).rejects.toThrow("timed out");
      const other = backend.remote(scoped, { action: "owned-port" });
      await vi.advanceTimersByTimeAsync(21);
      await failure;
      expect(execute).not.toHaveBeenCalled();
      initialized();
      await other;
      await backend.remote(scoped, { action: "read" }, { deadlineMs: Date.now() + 1000 });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); sshFactory.mockReset(); }
  });
  it("does not resume after the file readiness budget has expired", async () => {
    let clock = 1_000_000;
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetcher = vi.fn(async () => {
      clock += 120_000;
      return json({ sandbox: { id: "bx_test", state: "archived", snapshots: true, stop: null } });
    });
    try {
      await expect(boatBackend(async () => "fixture", fetcher).ready(record, { deadlineMs: 1_120_000 })).rejects.toThrow("timed out");
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { time.mockRestore(); }
  });
  it("reads outgoing and listening TCP ports across IPv4 and IPv6", () => {
    const root = mkdtempSync(join(tmpdir(), "boat-port-inventory-"));
    try {
      writeFileSync(join(root, "range"), "32768 60999\n");
      writeFileSync(join(root, "tcp"), "header\n0: 00000000:3F00 00000000:0000 0A\n");
      writeFileSync(join(root, "tcp6"), "header\n0: 00000000000000000000000000000000:A87A 00000000:01BB 08\n");
      const program = runnerPortInventoryProgram
        .replace("/proc/sys/net/ipv4/ip_local_port_range", join(root, "range"))
        .replace("/proc/net/tcp6", join(root, "tcp6"))
        .replace("/proc/net/tcp", join(root, "tcp"));
      const result = spawnSync("python3", ["-c", program], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ephemeralStart: 32768, ephemeralEnd: 60999, occupied: [16128, 43130] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("recognizes idle as an already running computer", async () => {
    const fetcher = vi.fn(async () =>
      json({
        sandbox: { id: "bx_test", state: "idle", snapshots: true, stop: null },
      }),
    );
    await boatBackend(async () => "secret", fetcher).ready(record);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects another physical ID and snapshot-disabled computers", async () => {
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ sandbox: { id: "bx_wrong", state: "idle", snapshots: true } }),
        ),
      ).inspect(record),
    ).rejects.toMatchObject({ code: "provider_error" });
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ sandbox: { id: "bx_test", state: "idle", snapshots: false } }),
        ),
      ).ready(record),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("keeps port credentials out of the WSS URL and does not forward API authorization to the hosting origin", async () => {
    const fetcher = vi.fn(async (url: any, options?: any) =>
      String(url).startsWith("https://boat.dev/")
        ? json({
            url: "https://test.on.boat.dev/?_token=private-token",
            access: "private",
          })
        : new Response(null, {
            status: 302,
            headers: {
              "set-cookie": "_port_auth=private-cookie; Secure; HttpOnly",
            },
          }),
    );
    const endpoint = await boatBackend(
      async () => "api-secret",
      fetcher,
    ).ingress(record, 43127, "/runner/ws");
    expect(endpoint).toEqual({
      url: "wss://test.on.boat.dev/runner/ws",
      secretHeaders: { Cookie: "_port_auth=private-cookie" },
    });
    expect(fetcher.mock.calls[1]![1].headers).toBeUndefined();
    expect(fetcher.mock.calls[1]![1].redirect).toBe("manual");
  });
  it("refuses public ports and arbitrary hosting origins", async () => {
    for (const url of [
      "http://test.on.boat.dev/?_token=x",
      "https://evil.example/?_token=x",
    ])
      await expect(
        boatBackend(
          async () => "secret",
          vi.fn(async () => json({ url, access: "private" })),
        ).preview(record, 5173),
      ).rejects.toMatchObject({ code: "provider_error" });
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ url: "https://test.on.boat.dev/", access: "public" }),
        ),
      ).preview(record, 5173),
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});

const roots: string[] = [];
function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-files-")));
  roots.push(temp);
  const root = join(temp, "home");
  const call = (input: Record<string, unknown>, env = process.env) => {
    const result = spawnSync(
      "python3",
      ["-c", remoteProgram.replaceAll("/home/user/paperclip/", `${temp}/`)],
      { input: JSON.stringify({ ...input, root }), encoding: "utf8", env },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, temp, call };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("confined computer files", () => {
  function interruptedWrite() {
    const f = fixture();
    f.call({ action: "seed", files: { "nested/notes": Buffer.from("original").toString("base64") } });
    const result = spawnSync("python3", ["-c", remoteProgram
      .replaceAll("/home/user/paperclip/", `${f.temp}/`)
      .replace("f.write(data);f.flush();os.fsync(f.fileno())", "f.write(data);f.flush();os.kill(os.getpid(),9)")], {
      input: JSON.stringify({ root: f.root, action: "write", path: "nested/notes", expectedSha256: createHash("sha256").update("original").digest("hex"), base64: Buffer.from("interrupted content").toString("base64") }),
      encoding: "utf8",
    });
    expect(result.signal).toBe("SIGKILL");
    const receipt = JSON.parse(readFileSync(join(f.root, ".paperclip-editor.lock"), "utf8"));
    expect(readFileSync(join(f.root, receipt.path), "utf8")).toBe("interrupted content");
    return { ...f, receipt };
  }
  it("reclaims only the recorded interrupted write before the next file operation", () => {
    const f = interruptedWrite();
    expect(f.call({ action: "list", path: "nested" }).entries.map((entry: { name: string }) => entry.name)).toEqual(["notes"]);
    expect(readFileSync(join(f.root, "nested/notes"), "utf8")).toBe("original");
    expect(readFileSync(join(f.root, ".paperclip-editor.lock"), "utf8")).toBe("");
  });
  it("clears the write receipt after a successful atomic save", () => {
    const f = fixture(); f.call({ action: "seed", files: {} });
    expect(f.call({ action: "write", path: "notes", expectedSha256: null, base64: Buffer.from("saved").toString("base64") })).toEqual({ sha256: createHash("sha256").update("saved").digest("hex") });
    expect(readFileSync(join(f.root, "notes"), "utf8")).toBe("saved");
    expect(readFileSync(join(f.root, ".paperclip-editor.lock"), "utf8")).toBe("");
    expect(readdirSync(f.root).sort()).toEqual([".paperclip-editor.lock", "notes"]);
  });
  it("preserves a replacement inode and unrelated temp-looking user files", () => {
    const f = interruptedWrite();
    const temp = join(f.root, f.receipt.path);
    renameSync(temp, join(f.root, "user-kept-content"));
    writeFileSync(temp, "replacement user file");
    const unrelated = join(f.root, ".paperclip-write-" + "a".repeat(32));
    writeFileSync(unrelated, "unrelated user file");
    f.call({ action: "list", path: "" });
    expect(readFileSync(temp, "utf8")).toBe("replacement user file");
    expect(readFileSync(unrelated, "utf8")).toBe("unrelated user file");
    expect(readFileSync(join(f.root, "user-kept-content"), "utf8")).toBe("interrupted content");
    expect(readFileSync(join(f.root, "nested/notes"), "utf8")).toBe("original");
  });
  it("preserves a symlink replacing the recorded temp without following it", () => {
    const f = interruptedWrite();
    const temp = join(f.root, f.receipt.path);
    renameSync(temp, join(f.root, "user-kept-content"));
    const outside = join(f.temp, "outside"); writeFileSync(outside, "preserve");
    symlinkSync(outside, temp);
    f.call({ action: "list", path: "nested" });
    expect(readFileSync(outside, "utf8")).toBe("preserve");
    expect(existsSync(temp)).toBe(true);
  });
  it("leaves only an empty temp when killed before its ownership receipt", () => {
    const f = fixture(); f.call({ action: "seed", files: {} });
    const result = spawnSync("python3", ["-c", remoteProgram
      .replaceAll("/home/user/paperclip/", `${f.temp}/`)
      .replace("record_write(relative,f.fileno())", "os.kill(os.getpid(),9)")], {
      input: JSON.stringify({ root: f.root, action: "write", path: "notes", expectedSha256: null, base64: Buffer.from("must not reach disk").toString("base64") }), encoding: "utf8",
    });
    expect(result.signal).toBe("SIGKILL");
    const temp = readdirSync(f.root).find(name => name.startsWith(".paperclip-write-"))!;
    f.call({ action: "list", path: "" });
    expect(statSync(join(f.root, temp)).size).toBe(0);
    expect(existsSync(join(f.root, "notes"))).toBe(false);
  });
  it("seeds absent home only and preserves existing content", () => {
    const f = fixture();
    expect(
      f.call({
        action: "seed",
        files: { "nested/one": Buffer.from("first").toString("base64") },
      }),
    ).toEqual({ seeded: true });
    expect(
      f.call({
        action: "seed",
        files: { "nested/one": Buffer.from("overwrite").toString("base64") },
      }),
    ).toEqual({ seeded: false });
    expect(
      Buffer.from(
        f.call({ action: "read", path: "nested/one" }).base64,
        "base64",
      ).toString(),
    ).toBe("first");
  });
  it("rejects traversal, symlink escapes, and oversized reads", () => {
    const f = fixture();
    f.call({
      action: "seed",
      files: { ok: Buffer.from("12345").toString("base64") },
    });
    mkdirSync(join(f.temp, "outside"));
    writeFileSync(join(f.temp, "outside", "secret"), "private");
    symlinkSync(join(f.temp, "outside"), join(f.root, "escape"));
    expect(f.call({ action: "read", path: "../outside/secret" })).toEqual({
      error: "invalid",
    });
    expect(f.call({ action: "read", path: "escape/secret" })).toEqual({
      error: "invalid",
    });
    expect(f.call({ action: "read", path: "ok", maxBytes: 4 })).toEqual({
      error: "invalid",
    });
  });
  it("publishes bounded seed chunks atomically and aborts partial homes", () => {
    const f = fixture(); const seedId = randomUUID();
    expect(f.call({ action: "seed-begin", seedId })).toEqual({ started: true });
    const chunk = Buffer.alloc(1024 * 1024, 19);
    for (const offset of [0, chunk.length]) expect(f.call({ action: "seed-chunk", seedId, path: "memory/data", offset, base64: chunk.toString("base64") })).toEqual({});
    expect(existsSync(f.root)).toBe(false);
    const staging = readdirSync(f.temp).find(name => name.startsWith(".paperclip-seed-") && statSync(join(f.temp, name)).isDirectory())!;
    expect(statSync(join(f.temp, staging)).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.temp, staging, "tree", "memory", "data")).mode & 0o777).toBe(0o600);
    expect(f.call({ action: "seed-chunk", seedId, path: "memory/data", offset: 0, base64: "" })).toEqual({ error: "conflict" });
    expect(f.call({ action: "seed-commit", seedId })).toEqual({ seeded: true });
    expect(readFileSync(join(f.root, "memory", "data"))).toEqual(Buffer.concat([chunk, chunk]));
    expect(readdirSync(f.temp)).toEqual([".paperclip-seed-home.lock", "home"]);
    expect(f.call({ action: "seed-begin", seedId: randomUUID() })).toEqual({ started: false });
    const g = fixture(); const partial = randomUUID();
    g.call({ action: "seed-begin", seedId: partial });
    expect(g.call({ action: "seed-chunk", seedId: partial, path: "../escape", offset: 0, base64: "" })).toEqual({ error: "invalid" });
    expect(g.call({ action: "seed-chunk", seedId: partial, path: "large", offset: 0, base64: Buffer.alloc(1024 * 1024 + 1).toString("base64") })).toEqual({ error: "invalid" });
    expect(g.call({ action: "seed-abort", seedId: partial })).toEqual({});
    expect(existsSync(g.root)).toBe(false);
    expect(readdirSync(g.temp)).toEqual([".paperclip-seed-home.lock"]);
  });
  it("does not replace a home created while its initial upload was in progress", () => {
    const f = fixture(); const seedId = randomUUID();
    f.call({ action: "seed-begin", seedId });
    f.call({ action: "seed-chunk", seedId, path: "initial", offset: 0, base64: Buffer.from("staged").toString("base64") });
    mkdirSync(f.root);
    expect(f.call({ action: "seed-commit", seedId })).toEqual({ seeded: false });
    expect(readdirSync(f.root)).toEqual([]);
    expect(readdirSync(f.temp)).toEqual([".paperclip-seed-home.lock", "home"]);
  });
  it("reclaims only the expired receipted upload after an interrupted seed", () => {
    const f = fixture(); const first = randomUUID(); const next = randomUUID();
    const receiptPath = join(f.temp, ".paperclip-seed-home.json");
    const oldStage = join(f.temp, `.paperclip-seed-home-${first}`);
    const unrelated = join(f.temp, `.paperclip-seed-home-${randomUUID()}`);
    mkdirSync(unrelated); writeFileSync(join(unrelated, "user-file"), "keep");
    expect(f.call({ action: "seed-begin", seedId: first })).toEqual({ started: true });
    expect(f.call({ action: "seed-chunk", seedId: first, path: "partial", offset: 0, base64: Buffer.alloc(1024 * 1024).toString("base64") })).toEqual({});
    expect(f.call({ action: "seed-begin", seedId: next })).toEqual({ error: "conflict" });
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.seedId).toBe(first); expect(receipt.updatedAt).toBeGreaterThan(0);
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, updatedAt: Date.now() / 1000 - 180 }));
    expect(f.call({ action: "seed-begin", seedId: next })).toEqual({ error: "conflict" });
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, updatedAt: 0 }));
    expect(f.call({ action: "seed-begin", seedId: next })).toEqual({ started: true });
    expect(existsSync(oldStage)).toBe(false);
    expect(f.call({ action: "seed-chunk", seedId: first, path: "late", offset: 0, base64: "" })).toEqual({ error: "conflict" });
    expect(readFileSync(join(unrelated, "user-file"), "utf8")).toBe("keep");
    expect(f.call({ action: "seed-abort", seedId: first })).toEqual({});
    expect(JSON.parse(readFileSync(receiptPath, "utf8")).seedId).toBe(next);
    expect(f.call({ action: "seed-chunk", seedId: next, path: "complete", offset: 0, base64: Buffer.from("done").toString("base64") })).toEqual({});
    expect(f.call({ action: "seed-commit", seedId: next })).toEqual({ seeded: true });
    expect(readFileSync(join(f.root, "complete"), "utf8")).toBe("done");
    expect(existsSync(receiptPath)).toBe(false);
  });
  it("cleans abandoned upload receipts on home admission but preserves unverified content", () => {
    const f = fixture(); const seedId = randomUUID();
    const receiptPath = join(f.temp, ".paperclip-seed-home.json");
    const stage = join(f.temp, `.paperclip-seed-home-${seedId}`);
    f.call({ action: "seed-begin", seedId });
    f.call({ action: "seed-chunk", seedId, path: "partial", offset: 0, base64: Buffer.from("partial").toString("base64") });
    mkdirSync(f.root); writeFileSync(join(f.root, "user-file"), "keep");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, updatedAt: 0 }));
    writeFileSync(join(stage, "owner.json"), JSON.stringify({ purpose: "user-owned" }));
    expect(f.call({ action: "list", limit: 1 })).toEqual({ error: "invalid" });
    expect(readFileSync(join(stage, "tree", "partial"), "utf8")).toBe("partial");
    writeFileSync(join(stage, "owner.json"), JSON.stringify({ purpose: receipt.purpose, root: receipt.root, seedId }));
    expect(f.call({ action: "list", limit: 1 }).entries[0].name).toBe("user-file");
    expect(existsSync(stage)).toBe(false); expect(existsSync(receiptPath)).toBe(false);
    expect(readFileSync(join(f.root, "user-file"), "utf8")).toBe("keep");
  });
  it("hashes and deletes files over the read limit while fencing changed bytes", () => {
    const f = fixture();
    f.call({ action: "seed", files: {} });
    const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
    writeFileSync(join(f.root, "large.bin"), bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(f.call({ action: "read", path: "large.bin" })).toEqual({ error: "invalid" });
    expect(f.call({ action: "hash", path: "large.bin" })).toEqual({ sha256: expected, size: bytes.length });
    bytes[0] = 8;
    writeFileSync(join(f.root, "large.bin"), bytes);
    expect(f.call({ action: "remove", path: "large.bin", expectedSha256: expected })).toEqual({ error: "conflict" });
    const current = f.call({ action: "hash", path: "large.bin" });
    expect(current.sha256).not.toBe(expected);
    expect(f.call({ action: "remove", path: "large.bin", expectedSha256: current.sha256 })).toEqual({});
    expect(f.call({ action: "hash", path: "large.bin" })).toEqual({ error: "not_found" });
    symlinkSync(join(f.temp, "outside"), join(f.root, "escape"));
    expect(f.call({ action: "hash", path: "escape" })).toEqual({ error: "invalid" });
    expect(f.call({ action: "hash", path: "../outside" })).toEqual({ error: "invalid" });
  });
  it("rejects stale edits and uses no-clobber move semantics", () => {
    const f = fixture();
    f.call({ action: "seed", files: {} });
    const first = f.call({
      action: "write",
      path: "file",
      expectedSha256: null,
      base64: Buffer.from("one").toString("base64"),
    });
    const second = f.call({
      action: "write",
      path: "file",
      expectedSha256: first.sha256,
      base64: Buffer.from("two").toString("base64"),
    });
    expect(
      f.call({
        action: "write",
        path: "file",
        expectedSha256: first.sha256,
        base64: "",
      }),
    ).toEqual({ error: "conflict" });
    expect(
      f.call({
        action: "move",
        path: "file",
        to: "other",
        expectedSha256: second.sha256,
      }),
    ).toEqual({ sha256: second.sha256 });
    expect(f.call({ action: "list" }).entries.map((e: any) => e.name)).toEqual([
      "other",
    ]);
    expect(
      f.call({ action: "remove", path: "other", expectedSha256: first.sha256 }),
    ).toEqual({ error: "conflict" });
  });
  it("bounds directory enumeration and stats files beyond the listing cap", () => {
    const f = fixture();
    f.call({ action: "seed", files: {} });
    for (let i = 0; i < 1005; i++) writeFileSync(join(f.root, `file-${i}`), "content");
    const page = f.call({ action: "list" });
    expect(page.entries).toHaveLength(1000);
    expect(page.truncated).toBe(true);
    const omitted = Array.from({ length: 1005 }, (_, i) => `file-${i}`).find(name => !page.entries.some((entry: { name: string }) => entry.name === name))!;
    expect(f.call({ action: "stat", path: omitted })).toMatchObject({ name: omitted, kind: "file", size: 7 });
    expect(f.call({ action: "list", limit: 2 }).entries).toHaveLength(2);
    expect(f.call({ action: "list", limit: 1001 })).toEqual({ error: "invalid" });
  });
  it("clones a private checkout with operation-scoped auth and leaves no credential material behind", () => {
    const f = fixture();
    const source = join(f.temp, "source");
    mkdirSync(source);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    for (const args of [["init"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base"]]) {
      expect(spawnSync(realGit, args, { cwd: source, encoding: "utf8" }).status).toBe(0);
    }
    const bin = join(f.temp, "bin");
    mkdirSync(bin);
    // Stand in for an authenticated GitHub transport, using real Git and the
    // production URL-scoped credential helper, without any external network.
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const {spawnSync}=require("node:child_process");
const args=process.argv.slice(2), clone=args.indexOf("clone");
if(clone<0) process.exit(9);
if(args.some(arg=>arg.includes("scoped-fixture-token"))) process.exit(10);
const credential=spawnSync(process.env.FIXTURE_REAL_GIT,[...args.slice(0,clone),"credential","fill"],{input:"protocol=https\\nhost=github.com\\n\\n",encoding:"utf8"});
if(credential.status!==0||!credential.stdout.includes("password=scoped-fixture-token")) process.exit(11);
args[clone+2]=process.env.FIXTURE_SOURCE;
const result=spawnSync(process.env.FIXTURE_REAL_GIT,args,{encoding:"utf8"});
process.stdout.write(result.stdout||"");process.stderr.write(result.stderr||"");process.exit(result.status??1);
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_REAL_GIT: realGit, FIXTURE_SOURCE: source };
    const request = { action: "workspace", mode: "shared", repositoryUrl: "https://github.com/company/private.git" };
    expect(f.call(request, env)).toEqual({ error: "command_failed" });
    const gitAuth = buildGitAuthInvocation({ token: "scoped-fixture-token", source: "managed_connection", secretName: null });
    const result = f.call({ ...request, gitAuth }, env);
    expect(result.remoteCwd).toBe(join(f.root, "checkout"));
    const config = readFileSync(join(result.remoteCwd, ".git", "config"), "utf8");
    expect(config).not.toContain("scoped-fixture-token");
    expect(config).not.toContain("credential");
    expect(spawnSync(realGit, ["rev-parse", "HEAD"], { cwd: result.remoteCwd }).status).toBe(0);
  });
  it.each(["shared", "worktree"])("serializes concurrent first checkout creation for %s workspaces", async mode => {
    const f = fixture();
    const source = join(f.temp, "source"), bin = join(f.temp, "bin");
    mkdirSync(source); mkdirSync(bin);
    const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    for (const args of [["init"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base"]]) {
      expect(spawnSync(git, args, { cwd: source, encoding: "utf8" }).status).toBe(0);
    }
    const started = join(f.temp, "clone-started"), release = join(f.temp, "clone-release"), clones = join(f.temp, "clones");
    // Pause real Git cloning after its destination exists. The second actual
    // remote program must wait instead of inspecting this unfinished checkout.
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs=require("node:fs"),{spawnSync}=require("node:child_process");
const args=process.argv.slice(2),clone=args.indexOf("clone");
if(clone>=0){
 fs.appendFileSync(process.env.FIXTURE_CLONES,"clone\\n");
 fs.mkdirSync(args.at(-1),{recursive:true});fs.writeFileSync(process.env.FIXTURE_STARTED,"ready");
 const deadline=Date.now()+5000;
 while(!fs.existsSync(process.env.FIXTURE_RELEASE)){if(Date.now()>deadline)process.exit(90);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 const url=args[clone+2];args[clone+2]=process.env.FIXTURE_SOURCE;
 const result=spawnSync(process.env.FIXTURE_GIT,args,{encoding:"utf8"});
 if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status??1);}
 process.exit(spawnSync(process.env.FIXTURE_GIT,["-C",args.at(-1),"remote","set-url","origin",url]).status??1);
}
const result=spawnSync(process.env.FIXTURE_GIT,args,{encoding:"utf8"});
process.stdout.write(result.stdout||"");process.stderr.write(result.stderr||"");process.exit(result.status??1);
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_GIT: git, FIXTURE_SOURCE: source,
      FIXTURE_STARTED: started, FIXTURE_RELEASE: release, FIXTURE_CLONES: clones };
    const call = (taskId: string) => new Promise<{ remoteCwd: string }>((resolve, reject) => {
      const child = spawn("python3", ["-c", remoteProgram.replaceAll("/home/user/paperclip/", `${f.temp}/`)], { env });
      let stdout = "", stderr = "";
      child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
      child.on("error", reject); child.on("close", code => {
        if (code !== 0) reject(new Error(stderr));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
      child.stdin.end(JSON.stringify({ root: f.root, action: "workspace", mode, taskId, repositoryUrl: "https://github.com/company/shared.git" }));
    });
    const first = call("first");
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    const second = call("second");
    let status: unknown;
    try {
      status = await Promise.race([second.then(() => "completed"), new Promise(resolve => setTimeout(() => resolve("waiting"), 100))]);
    } finally { writeFileSync(release, "continue"); }
    const results = await Promise.all([first, second]);
    expect(status).toBe("waiting");
    expect(readFileSync(clones, "utf8").trim().split("\n")).toHaveLength(1);
    for (const [index, result] of results.entries()) {
      expect(result.remoteCwd).toBe(mode === "shared" ? join(f.root, "checkout") : join(f.root, "tasks", index === 0 ? "first" : "second"));
      expect(spawnSync(git, ["rev-parse", "--show-toplevel"], { cwd: result.remoteCwd, encoding: "utf8" }).stdout.trim()).toBe(result.remoteCwd);
    }
  });
  it("rejects substituted project locks without touching their target", () => {
    const f = fixture(); mkdirSync(f.root);
    const outside = join(f.temp, "outside"); writeFileSync(outside, "keep");
    symlinkSync(outside, join(f.root, ".paperclip-workspace.lock"));
    expect(f.call({ action: "workspace", mode: "shared" })).toEqual({ error: "invalid" });
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });
  it.each([false, true])("uses the requested worktree branch separately from its start ref (explicit base: %s)", explicitBase => {
    const f = fixture();
    const checkout = join(f.root, "checkout");
    mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "latest");
    const expectedHead = explicitBase ? base : git("rev-parse", "HEAD");
    const input = { action: "workspace", mode: "worktree", taskId: "issue-1", branch: "paperclip/task-issue-1", ...(explicitBase ? { baseRef: base } : {}) };
    const result = f.call(input);
    expect(result.remoteCwd).toBe(join(f.root, "tasks", "issue-1"));
    expect(git("-C", result.remoteCwd, "symbolic-ref", "--short", "HEAD")).toBe(input.branch);
    expect(git("-C", result.remoteCwd, "rev-parse", "HEAD")).toBe(expectedHead);
    writeFileSync(join(result.remoteCwd, "preserved"), "user work");
    expect(f.call({ ...input, branch: "another-branch" })).toEqual({ error: "conflict" });
    expect(git("-C", result.remoteCwd, "status", "--short")).toContain("preserved");
  });
  it("roundtrips binary bytes without interpreting text", () => {
    const f = fixture();
    const bytes = Buffer.from([0, 255, 254, 13, 10, 128]);
    f.call({ action: "seed", files: { binary: bytes.toString("base64") } });
    expect(
      Buffer.from(f.call({ action: "read", path: "binary" }).base64, "base64"),
    ).toEqual(bytes);
  });
});


describe("retired owner spool cleanup after provider resume", () => {
  function cleanupFixture(state = "inactive") {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-retired-")));
    roots.push(temp);
    const owners = join(temp, "owners");
    const bin = join(temp, "bin");
    const calls = join(temp, "systemctl-calls");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in *show*) printf '%s\\n' '${state}';; esac
`, { mode: 0o700 });
    const owner = (id: string, generation = 7) => {
      const root = join(owners, id);
      mkdirSync(join(root, "command-one"), { recursive: true });
      writeFileSync(join(root, "generation"), String(generation));
      writeFileSync(join(root, "command-one", "stdin"), "private command input", { mode: 0o600 });
      writeFileSync(join(root, "preserve"), "ownership metadata");
      return root;
    };
    const cleanup = (input = [{ id: "retired-owner", generation: 7 }]) => spawnSync(
      "python3", ["-c", processProgram.replaceAll("/home/user/.paperclip-owners", owners)],
      { input: JSON.stringify({ action: "cleanup-retired", owners: input }), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    return { temp, owners, calls, owner, cleanup };
  }

  it("reaps only recorded retired command spools and is idempotent", () => {
    const f = cleanupFixture();
    const retired = f.owner("retired-owner");
    const active = f.owner("active-owner");
    const outside = join(f.temp, "user-files");
    mkdirSync(outside);
    writeFileSync(join(outside, "preserve"), "user data");
    symlinkSync(outside, join(retired, "command-symlink"));
    expect(f.cleanup().status).toBe(0);
    expect(existsSync(join(retired, "command-one"))).toBe(false);
    expect(existsSync(join(retired, "retired"))).toBe(true);
    expect(readFileSync(join(retired, "preserve"), "utf8")).toBe("ownership metadata");
    expect(readFileSync(join(active, "command-one", "stdin"), "utf8")).toBe("private command input");
    expect(readFileSync(join(outside, "preserve"), "utf8")).toBe("user data");
    const calls = readFileSync(f.calls, "utf8");
    expect(calls).toContain("--user stop paperclip-retired-owner.slice paperclip-retired-owner.service");
    expect(calls).not.toContain("active-owner");
    expect(f.cleanup().status).toBe(0);
    expect(readFileSync(f.calls, "utf8")).toBe(calls);
  });

  it("preserves spools when retirement cannot be confirmed", () => {
    const f = cleanupFixture("active");
    const retired = f.owner("retired-owner");
    const result = f.cleanup();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("process retirement unconfirmed");
    expect(existsSync(join(retired, "command-one", "stdin"))).toBe(true);
  });

  it("rejects a stale generation without stopping its current process", () => {
    const f = cleanupFixture();
    const retired = f.owner("retired-owner", 8);
    expect(JSON.parse(f.cleanup().stdout)).toEqual({ error: "conflict" });
    expect(existsSync(join(retired, "command-one", "stdin"))).toBe(true);
    expect(existsSync(f.calls)).toBe(false);
  });

  it("rejects symlink owner roots and ignores missing retired roots", () => {
    const f = cleanupFixture();
    const active = f.owner("active-owner");
    symlinkSync(active, join(f.owners, "retired-owner"));
    expect(f.cleanup().stderr).toContain("invalid retired owner directory");
    expect(existsSync(join(active, "command-one", "stdin"))).toBe(true);
    expect(f.cleanup([{ id: "missing-owner", generation: 7 }]).status).toBe(0);
    expect(existsSync(f.calls)).toBe(false);
  });
});


describe("Boat desktop input readiness", () => {
  function desktopFixture(initiallyHealthy: boolean) {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-desktop-")));
    roots.push(temp);
    const runtime = join(temp, String(process.getuid!()));
    const bin = join(temp, "bin");
    const healthy = join(temp, "healthy");
    const calls = join(temp, "repairs");
    const units = join(temp, "units");
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(bin);
    if (initiallyHealthy) writeFileSync(healthy, "ready");
    writeFileSync(join(bin, "ibus"), "#!/bin/sh\ntest \"$HOME\" = /home/user && test \"$XDG_CONFIG_HOME\" = /home/user/.config && test \"$XDG_CACHE_HOME\" = /home/user/.cache || exit 1\nprintf '%s\\n' 'unix:path=/test/ibus'\n", { mode: 0o700 });
    writeFileSync(join(bin, "gdbus"), `#!/bin/sh\ntest -f '${healthy}'\n`, { mode: 0o700 });
    writeFileSync(join(bin, "ibus-daemon"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ntouch '${healthy}'\n`, { mode: 0o700 });
    writeFileSync(join(bin, "systemd-run"), `#!/usr/bin/env python3
import os,sys,json
args=sys.argv[1:]
with open(${JSON.stringify(units)},'a') as target:target.write(json.dumps(args)+'\\n')
env=dict(os.environ)
for arg in args:
 if arg.startswith('--setenv='):
  key,value=arg[len('--setenv='):].split('=',1);env[key]=value
command=args[args.index('--')+1:]
os.execve(command[0],command,env)
`, { mode: 0o700 });
    const call = (program = desktopReadinessProgram) => spawnSync("python3", ["-c", program.replaceAll("/run/user/", `${temp}/`).replaceAll("/usr/bin/ibus-daemon", join(bin, "ibus-daemon"))], {
      encoding: "utf8", env: { ...process.env, HOME: join(temp, "agent-home"), XDG_CONFIG_HOME: join(temp, "agent-config"), XDG_CACHE_HOME: join(temp, "agent-cache"), PATH: `${bin}:${process.env.PATH}` },
    });
    return { temp, runtime, healthy, calls, units, call };
  }

  it("preserves a healthy input service and emits no MCP protocol output", () => {
    const f = desktopFixture(true);
    const result = f.call();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(f.calls)).toBe(false);
  });

  it("repairs a disconnected restored socket and checks it again after another resume", () => {
    const f = desktopFixture(false);
    expect(f.call().status).toBe(0);
    const expected = `--replace --daemonize --xim --address unix:path=${f.runtime}/paperclip-ibus/bus\n`;
    expect(readFileSync(f.calls, "utf8")).toBe(expected);
    const unit = JSON.parse(readFileSync(f.units, "utf8").trim());
    expect(unit).toEqual(expect.arrayContaining(["--slice=app.slice", "--collect", "--property=ExitType=cgroup", "--setenv=HOME=/home/user"]));
    expect(unit.find((value: string) => value.startsWith("--unit="))).toMatch(/^--unit=paperclip-desktop-input-[a-f0-9]{32}\.service$/);
    expect(f.call().status).toBe(0);
    expect(readFileSync(f.calls, "utf8")).toBe(expected);
    rmSync(f.healthy);
    expect(f.call().status).toBe(0);
    expect(readFileSync(f.calls, "utf8")).toBe(expected.repeat(2));
  });

  it("checks input on explicit Connect but reuses credentials without daemon work during presence", async () => {
    const id = randomUUID();
    const scoped = { ...record, id, providerId: `bx_${id}` };
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "", timedOut: false, signal: null, pid: null, startedAt: "" }));
    sshFactory.mockReturnValue({ execute });
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/sshkey")
      ? json({ hostKey: "ssh-ed25519 AAAA", sshEndpoint: "fixture.invalid:2222" })
      : json({ desktopUrl: "https://fixture.on.boat.dev/" }));
    const backend = boatBackend(async () => "fixture-key", fetcher);
    const viewer = await backend.desktop(scoped);
    expect(execute).toHaveBeenCalledOnce();
    expect(await backend.desktop(scoped, { checkInput: false })).toEqual(viewer);
    expect(execute).toHaveBeenCalledOnce();
    expect(await backend.desktop(scoped)).toEqual(viewer);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/desktop"))).toHaveLength(1);
    sshFactory.mockReset();
  });
  it("rejects a symlink input directory without replacing the daemon", () => {
    const f = desktopFixture(false);
    symlinkSync(f.temp, join(f.runtime, "paperclip-ibus"));
    const result = f.call();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid desktop input directory");
    expect(existsSync(f.calls)).toBe(false);
  });

  it("executes the existing Cua MCP process only after input readiness", () => {
    const f = desktopFixture(false);
    const tool = boatBackend(async () => "unused").computerTool();
    const cua = join(f.temp, "cua");
    writeFileSync(cua, `#!/bin/sh\nprintf '%s\\n' "$*"\n`, { mode: 0o700 });
    expect(tool.command).toBe("python3");
    const result = f.call(tool.args[1]!.replaceAll("/opt/ascii/cua-driver/cua-driver", cua));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("mcp --socket /run/ascii-cua/driver.sock\n");
    expect(existsSync(f.healthy)).toBe(true);
  });
});


describe("Boat SSH admission", () => {
  const result = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "" };
  it("reserves lifecycle and identity capacity while bulk and long legacy commands are active", async () => {
    const admission = createBoatTransportAdmission();
    const completions: Array<() => void> = [];
    const runner = { execute: vi.fn(async () => new Promise<typeof result>((resolve) => completions.push(() => resolve(result)))) };
    const input = { command: "legacy", timeoutMs: 60_000 };
    const jobs = Array.from({ length: 8 }, () => admission(runner, { ...input, stdin: "x".repeat(1024 * 1024 + 1) }, true));
    jobs.push(admission(runner, input, false), admission(runner, input, false));
    await Promise.resolve();
    expect(runner.execute).toHaveBeenCalledTimes(6);
    jobs.push(admission(runner, { command: "retire", timeoutMs: 10_000 }, true));
    jobs.push(admission(runner, { command: "identity", timeoutMs: 10_000 }, true));
    await Promise.resolve();
    expect(runner.execute).toHaveBeenCalledTimes(8);
    while (completions.length) {
      completions.splice(0).forEach((finish) => finish());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(jobs);
    expect(runner.execute).toHaveBeenCalledTimes(12);
  });
  it("classifies checkout and file operations below reserved lifecycle capacity", async () => {
    const id = randomUUID();
    const scoped = { ...record, id, providerId: `bx_${id}` };
    const completions: Array<() => void> = [];
    const execute = vi.fn(async (_input: { stdin?: string }) => new Promise<typeof result>(resolve => {
      completions.push(() => resolve({ ...result, stdout: "{}" }));
    }));
    sshFactory.mockReturnValue({ execute });
    const backend = boatBackend(async () => "fixture-key", vi.fn(async () => json({
      hostKey: "ssh-ed25519 AAAA", sshEndpoint: "fixture.invalid:2222",
    })));
    const jobs = Array.from({ length: 8 }, (_, index) => backend.remote(scoped, {
      action: index % 2 ? "workspace" : "list", root: "/home/user/paperclip/company/project",
    }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(6));
    jobs.push(backend.retire(scoped, { id: "owner", generation: 1, kind: "runner", phase: "retiring", port: 43127,
      deadline: null, absoluteDeadline: null, process: null }));
    jobs.push(backend.remote(scoped, { action: "owned-port", port: 5173, ownerId: "owner" }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(8));
    const actions = execute.mock.calls.map(([input]) => JSON.parse(input.stdin!).action);
    expect(actions.filter(action => action === "workspace" || action === "list")).toHaveLength(6);
    expect(actions).toContain("retire"); expect(actions).toContain("owned-port");
    completions.splice(0).forEach(finish => finish());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(10));
    completions.splice(0).forEach(finish => finish());
    await Promise.all(jobs);
    sshFactory.mockReset();
  });
  it("expires queued work without starting it and preserves the original remaining timeout", async () => {
    vi.useFakeTimers();
    try {
      const admission = createBoatTransportAdmission();
      const completions: Array<() => void> = [];
      const runner = { execute: vi.fn(async (_input: { command: string; timeoutMs?: number }) => new Promise<typeof result>((resolve) => completions.push(() => resolve(result)))) };
      const jobs = Array.from({ length: 6 }, () => admission(runner, { command: "long", timeoutMs: 60_000 }, false));
      await vi.advanceTimersByTimeAsync(0);
      const expired = admission(runner, { command: "expired", timeoutMs: 100 }, false);
      const queued = admission(runner, { command: "queued", timeoutMs: 1000 }, false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await expired).toMatchObject({ timedOut: true, pid: null });
      expect(runner.execute).toHaveBeenCalledTimes(6);
      completions.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: "queued", timeoutMs: 800 }));
      completions.splice(0).forEach((finish) => finish());
      await Promise.all([...jobs, queued]);
    } finally { vi.useRealTimers(); }
  });
  it("releases all capacity after failed or cancelled transport commands without replay", async () => {
    const admission = createBoatTransportAdmission();
    const runner = { execute: vi.fn(async () => { throw new Error("transport cancelled"); }) };
    const settled = await Promise.allSettled(Array.from({ length: 12 }, () => admission(runner, { command: "once", timeoutMs: 1000 }, false)));
    expect(settled.every((entry) => entry.status === "rejected")).toBe(true);
    expect(runner.execute).toHaveBeenCalledTimes(12);
  });
});


describe("remote graceful retirement fence", () => {
  it("records the exact generation deadline and blocks late launch or generation reuse", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "computer-grace-")));
    roots.push(root);
    const owners = join(root, "owners");
    const boot = join(root, "boot");
    writeFileSync(boot, "boot-id");
    const code = processProgram.replaceAll("/home/user/.paperclip-owners", owners)
      .replaceAll("/proc/sys/kernel/random/boot_id", boot);
    const invoke = (action: string, owner: Record<string, unknown>) => {
      const result = spawnSync("python3", ["-c", code], { input: JSON.stringify({ action, owner }), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const owner = { id: "owned", generation: 7, phase: "retiring", retirementDeadline: "2099-01-01T00:00:00Z" };
    expect(invoke("advance", owner)).toEqual({});
    const marker = readFileSync(join(owners, "owned", "retiring.json"), "utf8");
    expect(JSON.parse(marker).deadline).toBe(Date.parse(owner.retirementDeadline));
    expect(invoke("launch", owner)).toEqual({ error: "conflict" });
    expect(invoke("advance", { ...owner, phase: "active", generation: 8 })).toEqual({ error: "conflict" });
    expect(invoke("advance", { ...owner, generation: 6 })).toEqual({ error: "conflict" });
    expect(readFileSync(join(owners, "owned", "retiring.json"), "utf8")).toBe(marker);
  });
});
