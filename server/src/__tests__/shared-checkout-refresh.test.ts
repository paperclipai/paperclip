import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, chmod } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  refreshSharedManagedCheckout,
  SHARED_CHECKOUT_REFRESH_MIN_INTERVAL_MS,
} from "../services/shared-checkout-refresh.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];
async function git(cwd: string, ...args: string[]) {
  return (await execFile("git", ["-C", cwd, ...IDENTITY, ...args])).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-shared-refresh-"));
  directories.push(root);
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  await execFile("git", ["init", "--bare", "--initial-branch=main", origin]);
  const seed = path.join(root, "seed");
  await execFile("git", ["clone", origin, seed]);
  await git(seed, "switch", "-c", "main");
  await writeFile(path.join(seed, "file.txt"), "initial\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "initial");
  await git(seed, "push", "origin", "main");
  await execFile("git", ["clone", origin, clone]);
  let counter = 0;
  const advanceOrigin = async () => {
    counter += 1;
    const other = path.join(root, `other-${counter}`);
    await execFile("git", ["clone", origin, other]);
    await writeFile(path.join(other, `advance-${counter}.txt`), `${counter}\n`);
    await git(other, "add", ".");
    await git(other, "commit", "-m", `advance ${counter}`);
    await git(other, "push", "origin", "main");
  };
  const markerPath = async () => path.resolve(clone, await git(clone, "rev-parse", "--git-path", "paperclip-shared-checkout-refresh"));
  return { root, origin, clone, advanceOrigin, markerPath };
}

describe("shared checkout refresh", () => {
  it("fast-forwards a clean default-branch checkout that is behind", async () => {
    const { origin, clone, advanceOrigin } = await fixture();
    await advanceOrigin();
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("fast_forwarded");
    expect(result.defaultBranch).toBe("main");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(await git(origin, "rev-parse", "main"));
  });

  it("skips a second refresh inside the interval", async () => {
    const { clone } = await fixture();
    await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    const second = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(second.status).toBe("skipped_recent");
  });

  it("refreshes again after the interval", async () => {
    const { clone, advanceOrigin } = await fixture();
    await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    await advanceOrigin();
    const later = await refreshSharedManagedCheckout(clone, {
      now: () => 1_000 + SHARED_CHECKOUT_REFRESH_MIN_INTERVAL_MS + 1,
    });
    expect(later.status).toBe("fast_forwarded");
  });

  it("reports an off-default branch without changing it", async () => {
    const { clone, advanceOrigin } = await fixture();
    await git(clone, "switch", "-c", "feature");
    await advanceOrigin();
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("skipped_off_default_branch");
    expect(await git(clone, "symbolic-ref", "--short", "HEAD")).toBe("feature");
    expect(result.notices.join("\n")).toContain("`feature`");
    expect(result.notices.join("\n")).toContain("`main`");
  });

  it("does not fast-forward a checkout with tracked modifications", async () => {
    const { clone, advanceOrigin } = await fixture();
    await advanceOrigin();
    await writeFile(path.join(clone, "file.txt"), "edited\n");
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("skipped_dirty");
    expect(await readFile(path.join(clone, "file.txt"), "utf8")).toBe("edited\n");
  });

  it("ignores untracked files", async () => {
    const { clone, advanceOrigin } = await fixture();
    await advanceOrigin();
    await writeFile(path.join(clone, "scratch.txt"), "scratch\n");
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("fast_forwarded");
  });

  it("reports a diverged default branch without changing it", async () => {
    const { clone, advanceOrigin } = await fixture();
    await writeFile(path.join(clone, "local.txt"), "local\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-m", "local");
    const head = await git(clone, "rev-parse", "HEAD");
    await advanceOrigin();
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("skipped_diverged");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  it("continues with a notice when fetch fails and throttles the next attempt", async () => {
    const { root, clone, markerPath } = await fixture();
    await git(clone, "remote", "set-url", "origin", path.join(root, "nonexistent"));
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("fetch_failed");
    expect(result.notices.length).toBeGreaterThan(0);
    await expect(access(await markerPath())).resolves.toBeUndefined();
    const second = await refreshSharedManagedCheckout(clone, { now: () => 2_000 });
    expect(second.status).toBe("skipped_recent");
    expect(second.notices).toEqual(result.notices);
  });

  it("still accepts a legacy plain-number marker", async () => {
    const { clone, markerPath } = await fixture();
    await writeFile(await markerPath(), "1000");
    const result = await refreshSharedManagedCheckout(clone, { now: () => 2_000 });
    expect(result.status).toBe("skipped_recent");
    expect(result.notices).toEqual([]);
  });

  it("treats a future marker as expired", async () => {
    const { clone, advanceOrigin, markerPath } = await fixture();
    await writeFile(await markerPath(), String(10_000_000));
    await advanceOrigin();
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("fast_forwarded");
  });

  it("bounds a hanging fetch with the fetch timeout", async () => {
    const { clone } = await fixture();
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => { socket.on("error", () => undefined); sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as net.AddressInfo;
      await git(clone, "remote", "set-url", "origin", `git://127.0.0.1:${port}/repo.git`);
      const started = Date.now();
      const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000, fetchTimeoutMs: 500 });
      expect(result.status).toBe("fetch_failed");
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("does not run repository hooks during refresh", async () => {
    const { root, clone, advanceOrigin } = await fixture();
    const hooks = path.join(root, "hooks");
    const sentinel = path.join(root, "hook-ran");
    await mkdir(hooks);
    const hook = path.join(hooks, "post-merge");
    const target = sentinel.split(path.sep).join("/");
    await writeFile(hook, `#!/bin/sh
echo ran > "${target}"
`);
    await chmod(hook, 0o755);
    await git(clone, "config", "core.hooksPath", hooks);
    await advanceOrigin();
    const result = await refreshSharedManagedCheckout(clone, { now: () => 1_000 });
    expect(result.status).toBe("fast_forwarded");
    await expect(access(sentinel)).rejects.toThrow();
  });

  it("coalesces concurrent refreshes of one checkout", async () => {
    const { clone, advanceOrigin } = await fixture();
    await advanceOrigin();
    let fetches = 0;
    const resolveGitAuth = async () => { fetches += 1; return null; };
    const [a, b] = await Promise.all([
      refreshSharedManagedCheckout(clone, { now: () => 1_000, resolveGitAuth }),
      refreshSharedManagedCheckout(clone, { now: () => 1_000, resolveGitAuth }),
    ]);
    expect(a).toBe(b);
    expect(a.status).toBe("fast_forwarded");
    expect(fetches).toBe(1);
  });
});
