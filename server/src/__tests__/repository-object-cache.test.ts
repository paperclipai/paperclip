import { execFile as execute } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { materializeManagedProjectWorkspace } from "../services/managed-repository-checkout.js";
import { assertReproducibleBaseGitStorage } from "../services/git-workspace-restoration.js";
import { readRepositoryObjectCache, resolveRepositoryObjectCache, publishRepositoryObjectCache } from "../services/repository-object-cache.js";
import * as preparationTiming from "../services/execution-preparation-timing.js";

const execFile = promisify(execute);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repository-object-cache-")); roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  const source = path.join(root, "source"); await fs.mkdir(source);
  const git = async (cwd: string, ...args: string[]) => (await execFile("git", ["-C", cwd, ...args])).stdout.trim();
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Fixture"); await git(source, "config", "user.email", "fixture@example.test");
  await fs.writeFile(path.join(source, "work.txt"), "initial\n");
  await git(source, "add", "."); await git(source, "commit", "-m", "initial");
  const repoUrl = pathToFileURL(source).href;
  const company = path.join(root, "cache", "company");
  const prepare = (name: string) => materializeManagedProjectWorkspace(path.join(root, name), { repoUrl, objectCacheCompanyDirectory: company });
  return { root, source, git, company, repoUrl, prepare };
}

it("retains remote branch tips so a primed clone transfers no existing objects", async () => {
  const f = await fixture();
  await f.git(f.source, "checkout", "-b", "feature");
  await fs.writeFile(path.join(f.source, "feature.txt"), "unmerged feature content\n");
  await f.git(f.source, "add", ".");
  await f.git(f.source, "commit", "-m", "feature");
  const featureHead = await f.git(f.source, "rev-parse", "HEAD");
  await f.git(f.source, "checkout", "main");
  await f.prepare("first");
  const cache = (await resolveRepositoryObjectCache(f.company, f.repoUrl, null))!;
  expect(await f.git(cache.directory, "rev-parse", "refs/remotes/origin/feature")).toBe(featureHead);

  const packTrace = path.join(f.root, "received.pack");
  vi.stubEnv("GIT_TRACE_PACKFILE", packTrace);
  await f.prepare("second");
  expect(await fs.stat(packTrace).then(stat => stat.size, () => 0)).toBe(0);
  const target = path.join(f.root, "second");
  expect(await f.git(target, "rev-parse", "origin/feature")).toBe(featureHead);
  await expect(fs.stat(path.join(target, ".git/objects/info/alternates"))).rejects.toMatchObject({ code: "ENOENT" });
  await fs.rm(f.company, { recursive: true });
  expect(await f.git(target, "show", "origin/feature:feature.txt")).toBe("unmerged feature content");
  await f.git(target, "fsck", "--full");
});

it("uses current remote refs and produces an independent checkout without private cached refs", async () => {
  const f = await fixture();
  await f.git(f.source, "checkout", "-b", "private");
  await fs.writeFile(path.join(f.source, "private.txt"), "private branch bytes");
  await f.git(f.source, "add", "."); await f.git(f.source, "commit", "-m", "private");
  const privateHead = await f.git(f.source, "rev-parse", "HEAD");
  await f.git(f.source, "checkout", "main");
  await f.prepare("first");
  const cache = (await resolveRepositoryObjectCache(f.company, f.repoUrl, null))!;
  expect(await readRepositoryObjectCache(cache)).toBe(cache.directory);
  await f.git(f.source, "branch", "-D", "private");
  await fs.writeFile(path.join(f.source, "work.txt"), "current\n");
  await f.git(f.source, "commit", "-am", "current"); await f.git(f.source, "tag", "current-tag");
  const currentHead = await f.git(f.source, "rev-parse", "HEAD");
  await f.prepare("second");
  const target = path.join(f.root, "second");
  expect(await f.git(target, "rev-parse", "HEAD")).toBe(currentHead);
  expect(await f.git(target, "rev-parse", "current-tag")).toBe(currentHead);
  expect(await fs.readFile(path.join(target, "work.txt"), "utf8")).toBe("current\n");
  await expect(f.git(target, "cat-file", "-e", privateHead)).rejects.toThrow();
  await expect(fs.stat(path.join(target, ".git/objects/info/alternates"))).rejects.toMatchObject({ code: "ENOENT" });
  await assertReproducibleBaseGitStorage(target);
  await fs.rm(f.company, { recursive: true });
  await f.git(target, "fsck", "--full");
  expect(await f.git(target, "show", "HEAD~1:work.txt")).toBe("initial");
});

it("never substitutes a cached checkout for an unavailable remote", async () => {
  const f = await fixture(); await f.prepare("first");
  await fs.rename(f.source, `${f.source}-unavailable`);
  await expect(f.prepare("denied")).rejects.toThrow("Failed to prepare managed checkout");
  await expect(fs.stat(path.join(f.root, "denied"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("separates company and current credential scopes", async () => {
  const f = await fixture();
  const auth = { source: "company_secret" as const, secretName: "GITHUB_TOKEN", configArgs: [], env: { TOKEN: "first-token" } };
  const first = await resolveRepositoryObjectCache(f.company, f.repoUrl, auth);
  const other = await resolveRepositoryObjectCache(f.company, f.repoUrl, { ...auth, env: { TOKEN: "new-token" } });
  const company = await resolveRepositoryObjectCache(path.join(f.root, "cache/other-company"), f.repoUrl, auth);
  expect(first!.directory).not.toBe(other!.directory); expect(first!.directory).not.toBe(company!.directory);
  expect(JSON.stringify(first)).not.toContain("first-token");
});

it("skips contended optional cache publication without delaying a fresh checkout", async () => {
  const f = await fixture();
  await resolveRepositoryObjectCache(f.company, f.repoUrl, null);
  await withDirectoryMergeLock(f.company, async () => {
    await f.prepare("first");
    expect(await fs.readdir(f.company)).toEqual([]);
  });
  expect(await fs.readFile(path.join(f.root, "first/work.txt"), "utf8")).toBe("initial\n");
});

it("rebuilds from the remote when the cached pack is corrupt", async () => {
  const f = await fixture(); await f.prepare("first");
  const cache = (await resolveRepositoryObjectCache(f.company, f.repoUrl, null))!;
  await f.git(cache.directory, "gc", "--prune=now");
  const packs = (await fs.readdir(path.join(cache.directory, "objects/pack"))).filter(entry => entry.endsWith(".pack"));
  expect(packs.length).toBeGreaterThan(0);
  for (const entry of packs) {
    const file = path.join(cache.directory, "objects/pack", entry);
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, "corrupted");
  }
  await f.git(path.join(f.root, "first"), "fsck", "--full");
  await f.prepare("second");
  expect(await fs.readFile(path.join(f.root, "second/work.txt"), "utf8")).toBe("initial\n");
});

it("still authenticates to the HTTP remote when a matching object cache exists", async () => {
  const f = await fixture();
  const remote = path.join(f.root, "remote.git");
  await execFile("git", ["clone", "--bare", f.source, remote]);
  await f.git(remote, "update-server-info");
  let revoked = false, rejected = 0;
  const server = createServer(async (request, response) => {
    if (revoked || request.headers.authorization !== "Bearer fixture-token") {
      rejected++; response.writeHead(403); response.end(); return;
    }
    const pathname = new URL(request.url!, "http://localhost").pathname;
    if (!/^\/[a-zA-Z0-9/._-]+$/.test(pathname) || pathname.includes("..")) { response.writeHead(404); response.end(); return; }
    const file = path.join(remote, pathname);
    if (!await fs.stat(file).then(stat => stat.isFile(), () => false)) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", "text/plain");
    createReadStream(file).pipe(response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const repoUrl = `http://127.0.0.1:${address.port}`;
    const resolveGitAuth = vi.fn(async () => ({ source: "company_secret" as const, secretName: "fixture", configArgs: [], env: {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Bearer fixture-token",
    } }));
    const prepare = (name: string) => materializeManagedProjectWorkspace(path.join(f.root, name), {
      repoUrl, objectCacheCompanyDirectory: f.company, resolveGitAuth,
    });
    await prepare("authorized");
    expect(await fs.readdir(f.company)).toHaveLength(1);
    revoked = true;
    await expect(prepare("revoked")).rejects.toThrow("403");
    expect(rejected).toBeGreaterThan(0); expect(resolveGitAuth.mock.calls.length).toBeGreaterThanOrEqual(2);
    await expect(fs.stat(path.join(f.root, "revoked"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.root, "authorized/.git/config"), "utf8")).not.toContain("fixture-token");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it("does not follow a cache directory symlink or grow an over-capacity company", async () => {
  const f = await fixture();
  const cache = (await resolveRepositoryObjectCache(f.company, f.repoUrl, null))!;
  await fs.symlink(f.source, cache.directory);
  expect(await readRepositoryObjectCache(cache)).toBeNull();
  await fs.unlink(cache.directory);
  for (let i = 0; i < 64; i++) await fs.mkdir(path.join(f.company, `retained-${i}`));
  await publishRepositoryObjectCache(cache, f.source);
  expect(await fs.readdir(f.company)).toHaveLength(64);
  await expect(fs.stat(cache.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("skips oversized repositories without creating a cache generation", async () => {
  const f = await fixture();
  const cache = (await resolveRepositoryObjectCache(f.company, f.repoUrl, null))!;
  const oversized = path.join(f.source, ".git/oversized");
  await fs.writeFile(oversized, ""); await fs.truncate(oversized, 2 * 1024 ** 3 + 1);
  const detail = vi.spyOn(preparationTiming, "recordRepositoryObjectCacheDetail");
  await publishRepositoryObjectCache(cache, f.source);
  expect(detail).toHaveBeenLastCalledWith({ outcome: "capacity" });
  expect(await fs.readdir(f.company)).toEqual([]);
  expect(await f.git(f.source, "show", "HEAD:work.txt")).toBe("initial");
});

it("reports a symlink found during storage scanning as an invalid cache skip", async () => {
  const f = await fixture();
  const cache = (await resolveRepositoryObjectCache(f.company, f.repoUrl, null))!;
  await fs.symlink(f.source, path.join(f.source, ".git/unexpected-link"));
  const detail = vi.spyOn(preparationTiming, "recordRepositoryObjectCacheDetail");
  await publishRepositoryObjectCache(cache, f.source);
  expect(detail).toHaveBeenLastCalledWith({ outcome: "invalid" });
  expect(await fs.readdir(f.company)).toEqual([]);
});

it.each(["https://user:secret@github.com/fixture/repo", "https://github.com/fixture/repo?token=secret", "https://github.com/fixture/repo#secret"])("does not persist credential-bearing URLs: %s", async (repoUrl) => {
  const f = await fixture();
  expect(await resolveRepositoryObjectCache(f.company, repoUrl, null)).toBeNull();
  await expect(fs.stat(f.company)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not initialize or publish through a replaced cache parent", async () => {
  const f = await fixture();
  const other = path.join(f.root, "other"); await fs.mkdir(other);
  await fs.symlink(other, path.dirname(f.company));
  expect(await resolveRepositoryObjectCache(f.company, f.repoUrl, null)).toBeNull();
  expect(await fs.readdir(other)).toEqual([]);
  await fs.unlink(path.dirname(f.company));
  const cache = (await resolveRepositoryObjectCache(f.company, f.repoUrl, null))!;
  await fs.rename(path.dirname(f.company), path.join(f.root, "retained"));
  await fs.mkdir(path.join(other, "company")); await fs.symlink(other, path.dirname(f.company));
  await publishRepositoryObjectCache(cache, f.source);
  expect(await fs.readdir(path.join(other, "company"))).toEqual([]);
});
