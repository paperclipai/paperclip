import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withDirectoryMergeLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "./workspace-restore-merge.js";

describe("directory merge lock process lifetime", () => {
  const loader = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/cli.mjs", import.meta.url));
  const module = fileURLToPath(new URL("./workspace-restore-merge.ts", import.meta.url));
  const directories: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-process-"));
    directories.push(root);
    const target = path.join(root, "target");
    await mkdir(target);
    const env = { ...process.env, PAPERCLIP_HOME: path.join(root, "home"), PAPERCLIP_INSTANCE_ID: "test" };
    const key = createHash("sha256").update(await realpath(target)).digest("hex");
    const lock = path.join(env.PAPERCLIP_HOME, "instances", "test", "locks", "directory-merge", `${key}.lock`);
    return { target, env, lock };
  }

  async function holder(target: string, env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [loader, "--eval", `
      import { withDirectoryMergeLock } from ${JSON.stringify(module)};
      withDirectoryMergeLock(${JSON.stringify(target)}, async () => {
        process.send?.("locked");
        await new Promise(resolve => process.once("message", resolve));
      }).then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
    `], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child did not acquire lock: ${stderr}`)), 10_000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${stderr}`)); });
    });
    return child;
  }

  // Both protocols carry diagnostic owner records. This also lets the crash
  // regression demonstrate the old implementation's PID-reuse failure.
  async function ownerPath(lock: string) {
    return await access(`${lock}.owner.json`).then(() => `${lock}.owner.json`, () => path.join(lock, "owner.json"));
  }

  function expireWait() {
    const now = Date.now();
    return vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 60_000);
  }

  it("recovers a killed holder even when its recorded PID has been reused", async () => {
    const { target, env, lock } = await fixture();
    const child = await holder(target, env);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const recordPath = await ownerPath(lock);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...record, pid: process.pid }));
    const clock = expireWait();
    try {
      await expect(withDirectoryMergeLock(target, async () => "restored", env)).resolves.toBe("restored");
    } finally { clock.mockRestore(); }
  }, 15_000);

  it("protects a live holder in another process regardless of diagnostic PID or age", async () => {
    const { target, env, lock } = await fixture();
    const child = await holder(target, env);
    const recordPath = await ownerPath(lock);
    await writeFile(recordPath, JSON.stringify({ pid: 2_147_483_647, createdAt: "2000-01-01T00:00:00.000Z" }));
    const contender = vi.fn();
    const clock = expireWait();
    try {
      await expect(withDirectoryMergeLock(target, contender, env)).rejects.toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE });
    } finally { clock.mockRestore(); }
    expect(contender).not.toHaveBeenCalled();
    const exited = once(child, "exit");
    child.send("release");
    await exited;
    await expect(withDirectoryMergeLock(target, async () => "released", env)).resolves.toBe("released");
  }, 15_000);

  it("releases ownership when the protected operation throws", async () => {
    const { target, env } = await fixture();
    await expect(withDirectoryMergeLock(target, async () => { throw new Error("operation failed"); }, env)).rejects.toThrow("operation failed");
    await expect(withDirectoryMergeLock(target, async () => "next", env)).resolves.toBe("next");
  });

  it("keeps the OS lock when a same-process contender closes its connection", async () => {
    const { target, env } = await fixture();
    await withDirectoryMergeLock(target, async () => {
      const clock = expireWait();
      try {
        await expect(withDirectoryMergeLock(target, async () => undefined, env)).rejects.toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE });
      } finally { clock.mockRestore(); }
      // A same-process test alone cannot prove that the OS lock survived: on
      // POSIX, closing an unmanaged descriptor can drop process-wide locks.
      const result = await promisify(execFile)(process.execPath, [loader, "--eval", `
        import { withDirectoryMergeLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from ${JSON.stringify(module)};
        const now = Date.now();
        let calls = 0;
        Date.now = () => now + calls++ * 60_000;
        withDirectoryMergeLock(${JSON.stringify(target)}, async () => "entered")
          .then(() => { console.error("Entered a live holder's lock"); process.exit(1); })
          .catch(error => {
            if (error.code !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) { console.error(error); process.exit(1); }
            console.log("blocked");
          });
      `], { env, timeout: 10_000 });
      expect(result.stdout.trim()).toBe("blocked");
    }, env);
  }, 15_000);

  it("does not serialize unrelated target directories", async () => {
    const { target, env } = await fixture();
    const other = `${target}-other`;
    await mkdir(other);
    await withDirectoryMergeLock(target, async () => {
      await expect(withDirectoryMergeLock(other, async () => "independent", env)).resolves.toBe("independent");
    }, env);
  });

  it("retains the same database inode across holders", async () => {
    const { target, env, lock } = await fixture();
    await withDirectoryMergeLock(target, async () => undefined, env);
    const before = await stat(`${lock}.sqlite`);
    await withDirectoryMergeLock(target, async () => undefined, env);
    const after = await stat(`${lock}.sqlite`);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  });

  it("closes the kernel lock when writing diagnostics fails", async () => {
    const { target, env, lock } = await fixture();
    await mkdir(`${lock}.owner.json`, { recursive: true });
    await expect(withDirectoryMergeLock(target, async () => undefined, env)).rejects.toThrow();
    await rm(`${lock}.owner.json`, { recursive: true });
    await expect(withDirectoryMergeLock(target, async () => "next", env)).resolves.toBe("next");
  });

  it.each(["missing", "malformed", "dead PID"])("does not guess ownership of a legacy lock with %s metadata", async (kind) => {
    const { target, env, lock } = await fixture();
    await mkdir(lock, { recursive: true });
    if (kind !== "missing") await writeFile(path.join(lock, "owner.json"), kind === "malformed" ? "{broken" : JSON.stringify({ pid: 2_147_483_647, createdAt: "2000-01-01T00:00:00.000Z" }));
    const contender = vi.fn();
    const clock = expireWait();
    try {
      await expect(withDirectoryMergeLock(target, contender, env)).rejects.toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE });
    } finally { clock.mockRestore(); }
    expect(contender).not.toHaveBeenCalled();
    expect((await stat(lock)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32").each(["symlink", "hard link"])("rejects a lock database that is a %s", async (kind) => {
    const { target, env, lock } = await fixture();
    await mkdir(path.dirname(lock), { recursive: true });
    const decoy = `${target}-decoy`;
    await writeFile(decoy, "keep");
    await (kind === "symlink" ? symlink(decoy, `${lock}.sqlite`) : link(decoy, `${lock}.sqlite`));
    await expect(withDirectoryMergeLock(target, async () => undefined, env)).rejects.toThrow("not a plain, unshared file");
    await expect(readFile(decoy, "utf8")).resolves.toBe("keep");
  });
});
