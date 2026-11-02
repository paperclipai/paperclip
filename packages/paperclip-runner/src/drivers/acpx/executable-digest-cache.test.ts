import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutableDigestCache, executableDigestCache, type ExecutableFileIdentity } from "../../executable-digest-cache.js";
import { openVerifiedRuntimeExecutable } from "./installation-integrity.js";

const temporary: string[] = [];
const identity: ExecutableFileIdentity = { device: "1", inode: "2", size: "3", modifiedNanoseconds: "4", changedNanoseconds: "5" };
const digest = `sha256:${"a".repeat(64)}`;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-executable-digest-cache-"));
  temporary.push(root);
  const directory = join(root, "cache");
  const cache = createExecutableDigestCache(directory);
  return { root, directory, cache };
}

describe("persistent executable digest cache", () => {
  it("stores the actual digest in a private, versioned entry and survives a new cache instance", async () => {
    const f = await fixture();
    expect(await f.cache.read(identity)).toBeNull();
    await f.cache.write(identity, digest);
    expect(await createExecutableDigestCache(f.directory).read(identity)).toBe(digest);
    const [name] = await readdir(f.directory);
    expect(name).toMatch(/^v1-[a-f0-9]{64}\.json$/);
    expect(JSON.parse(await readFile(join(f.directory, name), "utf8"))).toEqual({ version: 1, digest });
    expect((await lstat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(f.directory, name))).mode & 0o777).toBe(0o600);
  });

  it.each(Object.keys(identity) as (keyof ExecutableFileIdentity)[])("invalidates a changed %s", async key => {
    const f = await fixture();
    await f.cache.write(identity, digest);
    expect(await f.cache.read({ ...identity, [key]: "changed" })).toBeNull();
  });

  it.each(["malformed", "version", "digest", "oversized", "permissions", "symlink"] as const)(
    "treats an unusable %s entry as a miss", async kind => {
      const f = await fixture();
      await f.cache.write(identity, digest);
      const [name] = await readdir(f.directory), file = join(f.directory, name);
      if (kind === "malformed") await writeFile(file, "{");
      else if (kind === "version") await writeFile(file, JSON.stringify({ version: 2, digest }));
      else if (kind === "digest") await writeFile(file, JSON.stringify({ version: 1, digest: "expected" }));
      else if (kind === "oversized") await writeFile(file, "x".repeat(1025));
      else if (kind === "permissions") await chmod(file, 0o644);
      else { await rename(file, `${file}.target`); await symlink(`${file}.target`, file); }
      expect(await f.cache.read(identity)).toBeNull();
    },
  );

  it("falls back when the cache directory cannot be used and leaves existing permissions unchanged", async () => {
    const f = await fixture();
    await writeFile(f.directory, "not a directory");
    await expect(f.cache.write(identity, digest)).resolves.toBeUndefined();
    expect(await f.cache.read(identity)).toBeNull();
    await rm(f.directory);
    await mkdir(f.directory, { mode: 0o755 });
    await f.cache.write(identity, digest);
    expect(await f.cache.read(identity)).toBeNull();
    expect((await lstat(f.directory)).mode & 0o777).toBe(0o755);
  });

  it("does not resolve a relative cache directory through the task working directory", async () => {
    const cache = createExecutableDigestCache("relative-task-cache");
    await cache.write(identity, digest);
    expect(await cache.read(identity)).toBeNull();
  });

  it("publishes complete entries under concurrent writers without leftover temporary files", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => f.cache.write(identity, digest)));
    expect(await f.cache.read(identity)).toBe(digest);
    expect(await readdir(f.directory)).toHaveLength(1);
  });
});

describe.skipIf(!["linux", "darwin"].includes(process.platform))("descriptor admission with cached digests", () => {
  async function executable() {
    const f = await fixture(), path = join(f.root, "native"), bytes = Buffer.from("qualified native fixture");
    await writeFile(path, bytes, { mode: 0o700 });
    vi.spyOn(executableDigestCache, "read").mockImplementation(f.cache.read);
    vi.spyOn(executableDigestCache, "write").mockImplementation(f.cache.write);
    return { ...f, path, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  }

  it("hashes a miss, reuses the actual digest, and still rejects a different independent pin", async () => {
    const f = await executable();
    await (await openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).handle.close();
    expect(executableDigestCache.write).toHaveBeenCalledOnce();
    await (await openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).handle.close();
    expect(executableDigestCache.write).toHaveBeenCalledOnce();
    await expect(openVerifiedRuntimeExecutable(f.path, digest, "fixture")).rejects.toThrow("digest mismatch");
  });

  it("rehashes changed contents and rejects corruption despite a previous valid entry", async () => {
    const f = await executable();
    await (await openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).handle.close();
    await writeFile(f.path, "corrupted native fixture");
    await expect(openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).rejects.toThrow("digest mismatch");
  });

  it.each(["permissions", "symlink", "replacement"] as const)("retains admission checks after cached %s changes", async kind => {
    const f = await executable();
    await (await openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).handle.close();
    if (kind === "permissions") {
      await chmod(f.path, 0o600);
      await expect(openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).rejects.toThrow("bounded executable file");
    } else if (kind === "symlink") {
      await rename(f.path, `${f.path}.original`); await symlink(`${f.path}.original`, f.path);
      await expect(openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).rejects.toThrow("real regular file");
    } else {
      await rename(f.path, `${f.path}.original`); await writeFile(f.path, "new invalid executable", { mode: 0o700 });
      await expect(openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).rejects.toThrow("digest mismatch");
    }
  });

  it("rejects mutation while a cache hit is being read", async () => {
    const f = await executable();
    await (await openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).handle.close();
    vi.mocked(executableDigestCache.read).mockImplementationOnce(async () => {
      await writeFile(f.path, "mutation during lookup");
      return f.digest;
    });
    await expect(openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).rejects.toThrow("changed while it was verified");
  });

  it("checks executable identity after publishing a cold cache entry", async () => {
    const f = await executable();
    vi.mocked(executableDigestCache.write).mockImplementationOnce(async (identity, digest) => {
      await f.cache.write(identity, digest);
      await writeFile(f.path, "mutation during cache publication");
    });
    await expect(openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).rejects.toThrow("changed while it was verified");
  });

  it("falls back to hashing when the cache is unavailable", async () => {
    const f = await executable();
    await writeFile(f.directory, "unavailable cache");
    await (await openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).handle.close();
    await writeFile(f.path, "invalid native fixture");
    await expect(openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).rejects.toThrow("digest mismatch");
  });

  it("trusts a digest planted by the same operating-system user for current metadata", async () => {
    const f = await executable();
    await writeFile(f.path, "content changed by the same user");
    const metadata = await lstat(f.path, { bigint: true });
    await f.cache.write({ device: metadata.dev.toString(), inode: metadata.ino.toString(), size: metadata.size.toString(),
      modifiedNanoseconds: metadata.mtimeNs.toString(), changedNanoseconds: metadata.ctimeNs.toString() }, f.digest);
    await (await openVerifiedRuntimeExecutable(f.path, f.digest, "fixture")).handle.close();
  });
});
