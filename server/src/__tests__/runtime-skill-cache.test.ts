import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySkill } from "@paperclipai/shared";
import { once } from "node:events";
import { releaseExitedRuntimeSkillCacheLock, removeRuntimeSkillCache, resolveRuntimeSkillCache, runtimeSkillCacheLockHolderExited, runtimeSkillCacheSpec } from "../services/runtime-skill-cache.js";
import { currentControllerProcessStamp } from "../services/controller-process-identity.js";

/** A PID whose process has exited and been reaped. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

const lockStamp = (controller: Record<string, unknown>, token: string = randomUUID()) =>
  Buffer.from(JSON.stringify({ pid: controller.pid, host: os.hostname(), token, controller }));

async function makeWritable(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await fs.chmod(root, 0o700);
  for (const item of await fs.readdir(root)) await makeWritable(path.join(root, item));
}

async function makeReadonly(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const item of await fs.readdir(root)) await makeReadonly(path.join(root, item));
  }
  await fs.chmod(root, stat.isDirectory() ? 0o555 : 0o444);
}

describe("runtime skill revision cache", () => {
  let root: string;
  let skill: CompanySkill;
  const contents: Record<string, string> = { "SKILL.md": "# Test", "references/a.md": "Supporting content" };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-cache-"));
    skill = { id: randomUUID(), companyId: randomUUID(), sourceType: "github", sourceLocator: "https://github.com/org/repo",
      sourceRef: "a".repeat(40), slug: "test", markdown: contents["SKILL.md"], metadata: { owner: "org", repo: "repo", repoSkillDir: "skills/test" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }, { path: "references/a.md", kind: "reference" }],
      key: "org/repo/test", name: "Test", description: null, trustLevel: "markdown_only", compatibility: "compatible",
      iconUrl: null, color: null, tagline: null, authorName: null, homepageUrl: null, categories: [], sharingScope: "company",
      publicShareToken: null, forkedFromSkillId: null, forkedFromCompanyId: null, starCount: 0, installCount: 0, forkCount: 0,
      currentVersionId: null, createdAt: new Date(0), updatedAt: new Date(0),
    };
  });
  afterEach(async () => { await makeWritable(root); await fs.rm(root, { recursive: true, force: true }); });
  const reader = () => vi.fn(async (file: string) => contents[file]);

  it("publishes complete contents once for twenty callers and leaves warm files untouched", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const read = reader();
    const sources = await Promise.all(Array.from({ length: 20 }, () => resolveRuntimeSkillCache(spec, read)));
    expect(new Set(sources).size).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await fs.stat(sources[0]!)).mode & 0o222).toBe(0);
    expect((await fs.stat(path.join(sources[0]!, "SKILL.md"))).mode & 0o222).toBe(0);
    const before = await fs.stat(path.join(sources[0]!, "SKILL.md"));
    read.mockRejectedValue(new Error("Upstream offline"));
    expect(await resolveRuntimeSkillCache(runtimeSkillCacheSpec(root, { ...skill })!, read)).toBe(sources[0]);
    expect(await resolveRuntimeSkillCache(spec, read, false)).toBe(sources[0]);
    expect((await fs.stat(path.join(sources[0]!, "SKILL.md"))).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readdir(sources[0]!)).toEqual(["SKILL.md", "references"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reuses the winning complete directory across concurrent processes and a process restart", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const launch = () => new Promise<{ source: string; reads: number }>((resolve, reject) => {
      const code = `
        import { resolveRuntimeSkillCache } from ${JSON.stringify(new URL("../services/runtime-skill-cache.ts", import.meta.url).href)};
        let reads = 0;
        const source = await resolveRuntimeSkillCache(${JSON.stringify(spec)}, async (file) => {
          reads++;
          await new Promise(resolve => setTimeout(resolve, 30));
          return ${JSON.stringify(contents)}[file];
        });
        console.log(JSON.stringify({ source, reads }));
      `;
      const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)), "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.on("error", reject);
      child.on("exit", (exitCode) => exitCode === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    });
    const [first, second] = await Promise.all([launch(), launch()]);
    expect(first.source).toBe(second.source);
    expect(await fs.readdir(spec.root)).toEqual([spec.fingerprint]);
    expect(await launch()).toEqual({ source: first.source, reads: 0 });
  });

  it("releases a publication lock at once when its holder provably exited", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const namespace = path.dirname(spec.root);
    await fs.mkdir(namespace, { recursive: true });
    const pid = await exitedPid();
    const token = randomUUID();
    const stale = lockStamp({ ...currentControllerProcessStamp(), bootId: randomUUID(), pid, processStartedAt: null }, token);
    // The crashed holder's owner file and its hard-linked lock, as publishLocked leaves them.
    await fs.writeFile(path.join(namespace, `.owner-${token}`), stale);
    await fs.link(path.join(namespace, `.owner-${token}`), path.join(namespace, `${skill.id}.lock`));
    const startedAt = Date.now();
    // Concurrent waiters in one process share one build; separate processes race for the claim.
    const sources = await Promise.all([resolveRuntimeSkillCache(spec, reader()),
      resolveRuntimeSkillCache(runtimeSkillCacheSpec(root, { ...skill })!, reader())]);
    expect(new Set(sources)).toEqual(new Set([path.join(spec.entry, "files")]));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await fs.readdir(namespace)).not.toContain(`${skill.id}.lock`);
  });

  it("takes over a release claim whose claimer exited before removing the stale lock", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const namespace = path.dirname(spec.root);
    await fs.mkdir(namespace, { recursive: true });
    const dead = { ...currentControllerProcessStamp(), bootId: randomUUID(), processStartedAt: null };
    const token = randomUUID();
    await fs.writeFile(path.join(namespace, `.owner-${token}`), lockStamp({ ...dead, pid: await exitedPid() }, token));
    await fs.link(path.join(namespace, `.owner-${token}`), path.join(namespace, `${skill.id}.lock`));
    // The waiter that claimed the stale lock crashed before unlinking it,
    // leaving its claim published from a kept owner file.
    const claimToken = randomUUID();
    await fs.writeFile(path.join(namespace, `.owner-${claimToken}`),
      JSON.stringify({ token: claimToken, controller: { ...dead, pid: await exitedPid() } }));
    await fs.link(path.join(namespace, `.owner-${claimToken}`), path.join(namespace, `${skill.id}.lock.released-${token}`));
    const startedAt = Date.now();
    expect(await resolveRuntimeSkillCache(spec, reader())).toBe(path.join(spec.entry, "files"));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("publishes a release claim only with its complete body", async () => {
    const namespace = path.join(root, "claims");
    await fs.mkdir(namespace);
    const lock = path.join(namespace, "skill.lock");
    const pid = await exitedPid();
    const token = randomUUID();
    await fs.writeFile(path.join(namespace, `.owner-${token}`),
      lockStamp({ ...currentControllerProcessStamp(), bootId: randomUUID(), pid, processStartedAt: null }, token));
    await fs.link(path.join(namespace, `.owner-${token}`), lock);
    const stale = await fs.lstat(lock);
    await releaseExitedRuntimeSkillCacheLock(namespace, lock, { inode: stale.ino, token });
    const claim = await fs.readFile(`${lock}.released-${token}`, "utf8");
    expect(JSON.parse(claim)).toMatchObject({ token: expect.any(String), controller: { pid: process.pid } });
    // The claim keeps an owner file with the same inode, so its inode is never reused.
    const claimInode = (await fs.lstat(`${lock}.released-${token}`)).ino;
    const owners = await Promise.all((await fs.readdir(namespace)).filter(name => name.startsWith(".owner-"))
      .map(async name => (await fs.lstat(path.join(namespace, name))).ino));
    expect(owners).toContain(claimInode);
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never removes a newer lock for a waiter that read a stale one late", async () => {
    const namespace = path.join(root, "locks");
    await fs.mkdir(namespace);
    const lock = path.join(namespace, "skill.lock");
    const staleToken = randomUUID();
    const liveToken = randomUUID();
    // The stale lock was already released and a live holder took the path.
    await fs.writeFile(path.join(namespace, `.owner-${liveToken}`), lockStamp(currentControllerProcessStamp(), liveToken));
    await fs.link(path.join(namespace, `.owner-${liveToken}`), lock);
    const live = await fs.lstat(lock);
    // Another waiter's claim exists: a late waiter does nothing, even when the
    // live lock happens to reuse the stale inode number.
    await fs.writeFile(`${lock}.released-${staleToken}`, "{}");
    await releaseExitedRuntimeSkillCacheLock(namespace, lock, { inode: live.ino, token: staleToken });
    expect((await fs.lstat(lock)).ino).toBe(live.ino);
    // Without a claim, a different inode keeps the live lock too.
    await releaseExitedRuntimeSkillCacheLock(namespace, lock, { inode: live.ino + 1, token: randomUUID() });
    expect((await fs.lstat(lock)).ino).toBe(live.ino);
  });

  it("never treats age, another host, or a legacy holder as proof that a lock holder exited", async () => {
    const pid = await exitedPid();
    const here = { ...currentControllerProcessStamp(), bootId: randomUUID(), pid, processStartedAt: null };
    expect(await runtimeSkillCacheLockHolderExited(lockStamp(here))).toBe(true);
    expect(await runtimeSkillCacheLockHolderExited(lockStamp({ ...here, hostHash: "another-host" }))).toBe(false);
    expect(await runtimeSkillCacheLockHolderExited(Buffer.from(JSON.stringify({ pid, host: os.hostname() })))).toBe(false);
    expect(await runtimeSkillCacheLockHolderExited(lockStamp({ ...here, pid: process.pid }))).toBe(false);
    expect(await runtimeSkillCacheLockHolderExited(lockStamp(currentControllerProcessStamp()))).toBe(false);
    expect(await runtimeSkillCacheLockHolderExited(Buffer.from("not json"))).toBe(false);
  });

  it("releases a lock whose holder ran in a deployment the platform replaced", async () => {
    // A Railway redeploy starts the server in a new process space, so a PID
    // proof never applies. The platform stopped the earlier deployment, which
    // held the same exclusive volume, before it started this one.
    const railway = { RAILWAY_PROJECT_ID: "project", RAILWAY_ENVIRONMENT_ID: "environment", RAILWAY_SERVICE_ID: "service",
      RAILWAY_DEPLOYMENT_ID: "deployment-new", RAILWAY_VOLUME_ID: "volume", RAILWAY_VOLUME_MOUNT_PATH: "/data" };
    for (const [key, value] of Object.entries(railway)) vi.stubEnv(key, value);
    try {
      const worker = { provider: "railway", projectId: "project", environmentId: "environment", serviceId: "service" };
      const holder = { bootId: randomUUID(), pid: 3, hostHash: "f".repeat(32), processStartedAt: null,
        deployment: { worker: { ...worker, deploymentId: "deployment-old" }, exclusiveVolume: true, volumeId: "volume" } };
      expect(await runtimeSkillCacheLockHolderExited(lockStamp(holder))).toBe(true);
      // Only a replaced deployment on the same exclusive volume is proof.
      const deployment = holder.deployment;
      for (const changed of [{ ...deployment, worker: { ...worker, deploymentId: "deployment-new" } },
        { ...deployment, volumeId: "another-volume" }, { ...deployment, exclusiveVolume: false },
        { ...deployment, worker: { ...worker, serviceId: "another-service", deploymentId: "deployment-old" } }]) {
        expect(await runtimeSkillCacheLockHolderExited(lockStamp({ ...holder, deployment: changed }))).toBe(false);
      }
      const { deployment: _omitted, ...withoutDeployment } = holder;
      expect(await runtimeSkillCacheLockHolderExited(lockStamp(withoutDeployment))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a lock held when the holder proof stalls or fails", async () => {
    // A distinct holder per case: a still-pending proof is joined by later waits on the same holder.
    const holder = () => ({ bootId: randomUUID(), pid: 3, hostHash: "f".repeat(32), processStartedAt: null });
    const startedAt = Date.now();
    expect(await runtimeSkillCacheLockHolderExited(lockStamp(holder()),
      { timeoutMs: 50, prove: () => new Promise(() => {}) })).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await runtimeSkillCacheLockHolderExited(lockStamp(holder()),
      { prove: async () => { throw new Error("database unavailable"); } })).toBe(false);
    expect(await runtimeSkillCacheLockHolderExited(lockStamp(holder()),
      { prove: async () => ({ verdict: "gone", reason: "controller_stopped" }) })).toBe(true);
  });

  it("joins a stalled holder proof instead of starting another read on every timeout", async () => {
    const holder = { bootId: randomUUID(), pid: 3, hostHash: "f".repeat(32), processStartedAt: null };
    let settle!: (proof: { verdict: "gone"; reason: "controller_stopped" }) => void;
    const prove = vi.fn(() => new Promise<{ verdict: "gone"; reason: "controller_stopped" }>(resolve => { settle = resolve; }));
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await runtimeSkillCacheLockHolderExited(lockStamp(holder), { timeoutMs: 10, prove })).toBe(false);
    }
    expect(prove).toHaveBeenCalledTimes(1);
    settle({ verdict: "gone", reason: "controller_stopped" });
    expect(await runtimeSkillCacheLockHolderExited(lockStamp(holder), { timeoutMs: 1_000, prove })).toBe(true);
    // A settled proof is not reused: the next wait asks again.
    await new Promise(resolve => setImmediate(resolve));
    const fresh = vi.fn(async () => ({ verdict: "alive" as const, reason: "controller_lease_held" as const }));
    expect(await runtimeSkillCacheLockHolderExited(lockStamp(holder), { prove: fresh })).toBe(false);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("fingerprints installed content and ownership, excluding cosmetic metadata", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    expect(runtimeSkillCacheSpec(root, { ...skill, name: "Renamed", updatedAt: new Date(), metadata: { ...skill.metadata, starred: true, ref: "new-branch" } })!.fingerprint).toBe(spec.fingerprint);
    expect(runtimeSkillCacheSpec(root, { ...skill, fileInventory: [...skill.fileInventory].reverse() })!.fingerprint).toBe(spec.fingerprint);
    for (const update of [{ companyId: randomUUID() }, { sourceRef: "b".repeat(40) }, { markdown: "changed" },
      { metadata: { ...skill.metadata, repoSkillDir: "other" } }]) {
      expect(runtimeSkillCacheSpec(root, { ...skill, ...update })!.fingerprint).not.toBe(spec.fingerprint);
    }
    expect(runtimeSkillCacheSpec(root, { ...skill, sourceRef: "main" })).toBeNull();
  });

  it("retains the old revision when publishing an explicit update", async () => {
    const old = await resolveRuntimeSkillCache(runtimeSkillCacheSpec(root, skill)!, reader());
    const next = await resolveRuntimeSkillCache(runtimeSkillCacheSpec(root, { ...skill, sourceRef: "b".repeat(40) })!, async () => "updated");
    expect(next).not.toBe(old);
    expect(await fs.readFile(path.join(old!, "references/a.md"), "utf8")).toBe(contents["references/a.md"]);
    expect(await fs.readFile(path.join(next!, "references/a.md"), "utf8")).toBe("updated");
  });

  it("never fingerprints mutable local sources as immutable cached revisions", () => {
    expect(runtimeSkillCacheSpec(root, { ...skill, sourceType: "local_path", sourceRef: null })).toBeNull();
  });

  it.each(["manifest-missing", "manifest-malformed", "changed", "deleted", "extra", "symlink"])("rejects %s without read-only repair, then rebuilds", async (corruption) => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const source = (await resolveRuntimeSkillCache(spec, reader()))!;
    await makeWritable(spec.entry);
    await fs.chmod(path.join(source, "SKILL.md"), 0o600);
    await fs.chmod(path.join(spec.entry, "manifest.json"), 0o600);
    const manifest = path.join(spec.entry, "manifest.json");
    if (corruption === "manifest-missing") await fs.unlink(manifest);
    if (corruption === "manifest-malformed") await fs.writeFile(manifest, "{bad");
    if (corruption === "changed") await fs.writeFile(path.join(source, "SKILL.md"), "tampered");
    if (corruption === "deleted") await fs.unlink(path.join(source, "SKILL.md"));
    if (corruption === "extra") await fs.writeFile(path.join(source, "extra.txt"), "extra");
    if (corruption === "symlink") {
      await fs.unlink(path.join(source, "SKILL.md"));
      await fs.symlink(path.join(root, "outside.txt"), path.join(source, "SKILL.md"));
      await fs.writeFile(path.join(root, "outside.txt"), "outside");
    }
    await makeReadonly(spec.entry);
    const read = reader();
    expect(await resolveRuntimeSkillCache(spec, read, false)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(await resolveRuntimeSkillCache(spec, read)).toBe(source);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(source, "SKILL.md"), "utf8")).toBe(contents["SKILL.md"]);
    if (corruption === "symlink") expect(await fs.readFile(path.join(root, "outside.txt"), "utf8")).toBe("outside");
  });

  it("does not publish partial builds and retries after a failed upstream read", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const read = reader().mockRejectedValueOnce(new Error("offline"));
    await expect(resolveRuntimeSkillCache(spec, read)).rejects.toThrow("offline");
    expect(await fs.readdir(spec.root)).toEqual([]);
    expect(await resolveRuntimeSkillCache(spec, read, false)).toBeNull();
    expect(await resolveRuntimeSkillCache(spec, read)).toBe(path.join(spec.entry, "files"));
  });

  it("coordinates cleanup with an active build and prevents a removed skill from being republished", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    let installed = true;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const build = resolveRuntimeSkillCache(spec, async (file) => {
      entered(); await gate; return contents[file];
    }, true, async () => installed);
    const rejected = expect(build).rejects.toThrow("renamed or removed");
    await started;
    installed = false;
    const removal = removeRuntimeSkillCache(root, skill.id);
    release();
    await rejected;
    await removal;
    await expect(fs.stat(spec.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveRuntimeSkillCache(spec, reader(), true, async () => installed)).rejects.toThrow("renamed or removed");
    await expect(fs.stat(spec.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../escape", "/absolute", "a/../../escape", "a/../b", "C:\\escape", "a\\..\\escape"])("rejects traversal %s", (file) => {
    expect(() => runtimeSkillCacheSpec(root, { ...skill, fileInventory: [...skill.fileInventory, { path: file, kind: "reference" }] })).toThrow("Invalid runtime skill file path");
  });

  it("rejects a symlink cache ancestor before invoking the source reader", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const outside = await fs.mkdtemp(path.join(root, "outside-"));
    await fs.symlink(outside, path.dirname(spec.root));
    const read = reader();
    await expect(resolveRuntimeSkillCache(spec, read)).rejects.toThrow("Unsafe");
    expect(read).not.toHaveBeenCalled();
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
