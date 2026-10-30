import fs from "node:fs/promises";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishWorkspaceSeedGeneration, readWorkspaceSeedGeneration } from "./workspace-seed-cache.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seed-cache-quota-")); roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  const company = path.join(root, "company"), workspace = path.join(company, "workspace");
  const archive = path.join(root, "run-seed.tar"); await fs.writeFile(archive, "run recovery bytes");
  const seed = { workspaceArchivePath: archive };
  return { root, company, workspace, archive, seed };
}
const generation = (index: number) => index.toString(16).padStart(64, "0");

it("returns verified private copies that survive subsequent cache changes", async () => {
  const f = await fixture();
  const git = path.join(f.root, "git.tar"); await fs.writeFile(git, "git recovery bytes");
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), { ...f.seed, gitArchivePath: git })).toBe(true);
  const destination = path.join(f.root, "staging"); await fs.mkdir(destination);
  const copy = await readWorkspaceSeedGeneration(f.workspace, generation(1), { privateCopyDirectory: destination });
  expect(copy).not.toBeNull();
  expect(path.dirname(copy!.workspaceArchivePath)).toBe(path.dirname(copy!.gitArchivePath!));
  expect(path.dirname(path.dirname(copy!.workspaceArchivePath))).toBe(destination);
  await fs.writeFile(path.join(f.workspace, generation(1), "workspace.tar"), "changed shared cache");
  await fs.rm(path.join(f.workspace, generation(1), "git.tar"));
  expect(await fs.readFile(copy!.workspaceArchivePath, "utf8")).toBe("run recovery bytes");
  expect(await fs.readFile(copy!.gitArchivePath!, "utf8")).toBe("git recovery bytes");
});

it("rejects corrupted private bytes and removes incomplete materialization", async () => {
  const f = await fixture();
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed)).toBe(true);
  const destination = path.join(f.root, "staging"); await fs.mkdir(destination);
  const copyFile = fs.copyFile.bind(fs);
  vi.spyOn(fs, "copyFile").mockImplementationOnce(async (...args) => {
    await copyFile(...args);
    await fs.writeFile(args[1], "corrupted during copy");
  });
  expect(await readWorkspaceSeedGeneration(f.workspace, generation(1), { privateCopyDirectory: destination })).toBeNull();
  expect(await fs.readdir(destination)).toEqual([]);
  expect(await fs.readFile(path.join(f.workspace, generation(1), "workspace.tar"), "utf8")).toBe("run recovery bytes");
});

it("cleans a verified workspace copy if the cached Git archive is corrupt", async () => {
  const f = await fixture();
  const git = path.join(f.root, "git.tar"); await fs.writeFile(git, "git recovery bytes");
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), { ...f.seed, gitArchivePath: git })).toBe(true);
  await fs.writeFile(path.join(f.workspace, generation(1), "git.tar"), "corrupt");
  const destination = path.join(f.root, "staging"); await fs.mkdir(destination);
  expect(await readWorkspaceSeedGeneration(f.workspace, generation(1), { privateCopyDirectory: destination })).toBeNull();
  expect(await fs.readdir(destination)).toEqual([]);
});

it("stops new workspace generations at capacity while retaining reusable and per-run seeds", async () => {
  const f = await fixture(); const options = { companyDirectory: f.company, limits: { workspaceGenerations: 1 } };
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
  const prior = await readWorkspaceSeedGeneration(f.workspace, generation(1));
  expect(prior).not.toBeNull();
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(false);
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
  expect(await fs.readdir(f.workspace)).toEqual([generation(1)]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
  expect(await fs.readFile(prior!.workspaceArchivePath, "utf8")).toBe("run recovery bytes");
});

it.each(["workspaceBytes", "companyBytes"] as const)("counts archive and receipt bytes against %s without creating an empty workspace", async (limit) => {
  const f = await fixture();
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
    companyDirectory: f.company, limits: { [limit]: 4096 },
  })).toBe(false);
  expect(await fs.readdir(f.company)).toEqual([]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
});

it.each(["companyGenerations", "companyWorkspaces"] as const)("serializes distinct-workspace publication against %s", async (limit) => {
  const f = await fixture(); const options = { companyDirectory: f.company, limits: { [limit]: 1 } };
  const results = await Promise.all(["first", "second"].map((name, index) =>
    publishWorkspaceSeedGeneration(path.join(f.company, name), generation(index), f.seed, options)));
  expect(results.sort()).toEqual([false, true]);
  expect(await fs.readdir(f.company)).toHaveLength(1);
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
});

it("keeps company-lock contention outside the locked-publication span", async () => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>(), verified = deferred<void>();
  const spans: string[][] = [[], []];
  const runtimeSpan = (index: number) => async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    spans[index].push(name);
    if (index === 0 && name === "workspace.seed_cache_locked_publish") {
      entered.resolve();
      await release.promise;
    }
    return work();
  };
  const first = publishWorkspaceSeedGeneration(path.join(f.company, "first"), generation(1), f.seed, {
    companyDirectory: f.company, runtimeSpan: runtimeSpan(0),
  });
  let second: Promise<boolean> | undefined;
  try {
    await entered.promise;
    second = publishWorkspaceSeedGeneration(path.join(f.company, "second"), generation(2), f.seed, {
      companyDirectory: f.company, runtimeSpan: runtimeSpan(1),
      verify: async () => { verified.resolve(); return true; },
    });
    await verified.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spans[1]).toContain("workspace.seed_cache_capacity");
    expect(spans[1]).not.toContain("workspace.seed_cache_locked_publish");
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  for (const names of spans) {
    expect(names).toContain("workspace.seed_cache_locked_publish");
    expect(names).toContain("workspace.seed_cache_evict");
    expect(names).toContain("workspace.seed_cache_sync");
    expect(names).toContain("workspace.seed_cache_hash");
  }
  for (const [name, index] of [["first", 1], ["second", 2]] as const) {
    const cached = await readWorkspaceSeedGeneration(path.join(f.company, name), generation(index), { companyDirectory: f.company });
    expect(await fs.readFile(cached!.workspaceArchivePath, "utf8")).toBe("run recovery bytes");
  }
});

it("applies the company byte cap across workspace roots", async () => {
  const f = await fixture();
  const options = { companyDirectory: f.company, limits: { companyBytes: 4500 } };
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
  const secondArchive = path.join(f.root, "second-seed.tar"); await fs.writeFile(secondArchive, "x".repeat(1000));
  expect(await publishWorkspaceSeedGeneration(path.join(f.company, "second"), generation(2), { workspaceArchivePath: secondArchive }, options)).toBe(false);
  expect(await fs.readdir(f.company)).toEqual(["workspace"]);
});

it("admits multiple recent workspaces into the company bucket without applying one workspace's quota to their sum", async () => {
  const f = await fixture(); await fs.writeFile(f.archive, "x".repeat(8192));
  const options = { companyDirectory: f.company, scope: "company" as const,
    limits: { workspaceGenerations: 1, workspaceBytes: 20_000, companyGenerations: 3, companyBytes: 100_000 } };
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(true);
  for (const index of [1, 2]) {
    const cached = await readWorkspaceSeedGeneration(f.workspace, generation(index));
    expect(await fs.readFile(cached!.workspaceArchivePath, "utf8")).toBe("x".repeat(8192));
  }
});

it.each(["companyGenerations", "companyBytes"] as const)("keeps the shared bucket within %s and preserves recently used seeds", async limit => {
  const f = await fixture(); await fs.writeFile(f.archive, "x".repeat(8192));
  const options = { companyDirectory: f.company, scope: "company" as const,
    limits: { workspaceGenerations: 1, workspaceBytes: 20_000, companyGenerations: 3, companyBytes: 100_000,
      [limit]: limit === "companyBytes" ? 25_000 : 2 } };
  for (const index of [1, 2]) expect(await publishWorkspaceSeedGeneration(f.workspace, generation(index), f.seed, options)).toBe(true);
  const verify = vi.fn(async () => true);
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(3), f.seed, { ...options, verify })).toBe(false);
  expect(verify).not.toHaveBeenCalled();
  expect((await fs.readdir(f.workspace)).sort()).toEqual([generation(1), generation(2)]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("x".repeat(8192));
});

it("evicts an old legacy workspace seed to make room for a new shared generation", async () => {
  const f = await fixture(); const now = Date.now();
  await fs.writeFile(f.archive, "x".repeat(8192));
  const limits = { workspaceGenerations: 1, workspaceBytes: 20_000, companyGenerations: 3, companyBytes: 40_000 };
  const legacy = path.join(f.company, "legacy");
  const legacyArchive = path.join(f.root, "legacy.tar"); await fs.writeFile(legacyArchive, "y".repeat(15_000));
  expect(await publishWorkspaceSeedGeneration(legacy, generation(0), { workspaceArchivePath: legacyArchive },
    { companyDirectory: f.company, limits, now: () => now })).toBe(true);
  const receipt = path.join(legacy, generation(0), "receipt.json");
  await fs.utimes(receipt, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
  const options = { companyDirectory: f.company, scope: "company" as const, limits, now: () => now };
  for (const index of [1, 2, 3]) expect(await publishWorkspaceSeedGeneration(f.workspace, generation(index), f.seed, options)).toBe(true);
  expect(await fs.readdir(f.company)).toEqual(["workspace"]);
  expect((await fs.readdir(f.workspace)).sort()).toEqual([generation(1), generation(2), generation(3)]);
  expect(await fs.readFile(legacyArchive, "utf8")).toBe("y".repeat(15_000));
});

it("retains the individual seed byte ceiling when the shared bucket has room", async () => {
  const f = await fixture(); await fs.writeFile(f.archive, "x".repeat(8192));
  const verify = vi.fn(async () => true);
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
    companyDirectory: f.company, scope: "company", limits: { workspaceBytes: 8192 }, verify,
  })).toBe(false);
  expect(verify).not.toHaveBeenCalled();
  expect(await fs.readdir(f.company)).toEqual([]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("x".repeat(8192));
});

it("rechecks the individual shared seed byte ceiling after verification", async () => {
  const f = await fixture(); await fs.writeFile(f.archive, "x".repeat(8192));
  const verify = vi.fn(async () => { await fs.writeFile(f.archive, "y".repeat(30_000)); return true; });
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
    companyDirectory: f.company, scope: "company", limits: { workspaceBytes: 20_000, companyBytes: 100_000 }, verify,
  })).toBe(false);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(f.company)).toEqual([]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("y".repeat(30_000));
});

it("serializes concurrent archive publication against the aggregate byte cap", async () => {
  const f = await fixture(); await fs.writeFile(f.archive, "x".repeat(1024));
  const options = { companyDirectory: f.company, limits: { companyBytes: 5500 } };
  const results = await Promise.all(["first", "second"].map((name, index) =>
    publishWorkspaceSeedGeneration(path.join(f.company, name), generation(index), f.seed, options)));
  expect(results.sort()).toEqual([false, true]);
  expect(await fs.readdir(f.company)).toHaveLength(1);
});

it("counts abandoned pending and pre-existing over-quota directories without deleting them", async () => {
  const f = await fixture(); await fs.mkdir(path.join(f.workspace, ".pending-old"), { recursive: true });
  await fs.writeFile(path.join(f.workspace, ".pending-old", "workspace.tar"), "retained");
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, {
    companyDirectory: f.company, limits: { workspaceGenerations: 0 },
  })).toBe(false);
  expect(await fs.readFile(path.join(f.workspace, ".pending-old", "workspace.tar"), "utf8")).toBe("retained");
  expect(await fs.readdir(f.workspace)).toEqual([".pending-old"]);
});

it("reserves full-copy disk capacity and skips a cache write without losing recovery", async () => {
  const f = await fixture();
  vi.spyOn(nodeFs, "statfsSync").mockReturnValue({ bavail: 256n * 1024n * 1024n, bsize: 1n } as ReturnType<typeof nodeFs.statfsSync>);
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, { companyDirectory: f.company })).toBe(false);
  expect(await fs.readdir(f.company)).toEqual([]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
});

it("supports cross-device archive copies independently of the per-run seed", async () => {
  const f = await fixture();
  vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, { companyDirectory: f.company })).toBe(true);
  await fs.unlink(f.archive);
  const cached = await readWorkspaceSeedGeneration(f.workspace, generation(1));
  expect(await fs.readFile(cached!.workspaceArchivePath, "utf8")).toBe("run recovery bytes");
});

it("skips optional verification when capacity is exhausted", async () => {
  const f = await fixture(); const verify = vi.fn(async () => true);
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
    companyDirectory: f.company, limits: { workspaceGenerations: 0 }, verify,
  })).toBe(false);
  expect(verify).not.toHaveBeenCalled();
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
});

it("treats optional verification storage failure as a cache miss", async () => {
  const f = await fixture();
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
    companyDirectory: f.company, verify: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
  })).toBe(false);
  expect(await fs.readdir(f.company)).toEqual([]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
});

it("does not hold the company publication lock during slow verification", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<boolean>();
  const slow = publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
    companyDirectory: f.company, verify: () => { entered.resolve(); return release.promise; },
  });
  try {
    await entered.promise;
    expect(await publishWorkspaceSeedGeneration(path.join(f.company, "second"), generation(2), f.seed,
      { companyDirectory: f.company })).toBe(true);
    expect(await fs.readdir(f.company)).toEqual(["second"]);
  } finally { release.resolve(true); await slow; }
  expect(await readWorkspaceSeedGeneration(f.workspace, generation(1))).not.toBeNull();
});

it("rechecks aggregate capacity after concurrent verifications finish", async () => {
  const f = await fixture();
  const release = deferred<boolean>();
  const entered = vi.fn(() => release.promise);
  const publications = ["first", "second"].map((name, index) => publishWorkspaceSeedGeneration(
    path.join(f.company, name), generation(index), f.seed,
    { companyDirectory: f.company, limits: { companyGenerations: 1 }, verify: entered },
  ));
  try { await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2)); }
  finally { release.resolve(true); }
  expect((await Promise.all(publications)).sort()).toEqual([false, true]);
  expect(await fs.readdir(f.company)).toHaveLength(1);
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
});

it("rejects a company directory replaced during verification", async () => {
  const f = await fixture();
  const replacement = path.join(f.root, "other-company"); await fs.mkdir(replacement);
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
    companyDirectory: f.company, verify: async () => {
      await fs.rename(f.company, `${f.company}-retained`);
      await fs.symlink(replacement, f.company);
      return true;
    },
  })).toBe(false);
  expect(await fs.readdir(replacement)).toEqual([]);
  expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
});

describe("eviction", () => {
  const DAY = 24 * 60 * 60 * 1000;
  async function lastUsed(directory: string, ms: number) {
    await fs.utimes(path.join(directory, "receipt.json"), new Date(ms), new Date(ms));
  }

  it("expires generations unused for the idle period when publishing, and removes emptied workspaces", async () => {
    const f = await fixture(); const now = Date.now(); const options = { companyDirectory: f.company, now: () => now };
    const other = path.join(f.company, "other");
    expect(await publishWorkspaceSeedGeneration(other, generation(1), f.seed, options)).toBe(true);
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(true);
    await lastUsed(path.join(other, generation(1)), now - 8 * DAY);
    await lastUsed(path.join(f.workspace, generation(2)), now - 6 * DAY);
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(3), f.seed, options)).toBe(true);
    expect((await fs.readdir(f.company)).sort()).toEqual(["workspace"]);
    expect((await fs.readdir(f.workspace)).sort()).toEqual([generation(2), generation(3)]);
    expect(await fs.readFile(f.archive, "utf8")).toBe("run recovery bytes");
  });

  it("counts a cache hit as use, so a recently read generation is not expired", async () => {
    const f = await fixture(); const options = { companyDirectory: f.company };
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
    await lastUsed(path.join(f.workspace, generation(1)), Date.now() - 8 * DAY);
    expect(await readWorkspaceSeedGeneration(f.workspace, generation(1))).not.toBeNull();
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(true);
    expect((await fs.readdir(f.workspace)).sort()).toEqual([generation(1), generation(2)]);
  });

  it("evicts the least recently used generation of the workspace when it is full", async () => {
    const f = await fixture(); const now = Date.now();
    const options = { companyDirectory: f.company, limits: { workspaceGenerations: 2 }, now: () => now };
    for (const index of [1, 2]) expect(await publishWorkspaceSeedGeneration(f.workspace, generation(index), f.seed, options)).toBe(true);
    await lastUsed(path.join(f.workspace, generation(1)), now - 3 * 60 * 60 * 1000);
    await lastUsed(path.join(f.workspace, generation(2)), now - 2 * 60 * 60 * 1000);
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(3), f.seed, options)).toBe(true);
    expect((await fs.readdir(f.workspace)).sort()).toEqual([generation(2), generation(3)]);
  });

  it("evicts across workspaces under company pressure but never a generation used within the last hour", async () => {
    const f = await fixture(); const now = Date.now();
    const options = { companyDirectory: f.company, limits: { companyGenerations: 2 }, now: () => now };
    const other = path.join(f.company, "other");
    expect(await publishWorkspaceSeedGeneration(other, generation(1), f.seed, options)).toBe(true);
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(true);
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(3), f.seed, options)).toBe(false);
    await lastUsed(path.join(other, generation(1)), now - 2 * 60 * 60 * 1000);
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(3), f.seed, options)).toBe(true);
    expect((await fs.readdir(f.company)).sort()).toEqual(["workspace"]);
    expect((await fs.readdir(f.workspace)).sort()).toEqual([generation(2), generation(3)]);
  });

  it("runs optional verification only when eviction can make room", async () => {
    const f = await fixture(); const now = Date.now(); const verify = vi.fn(async () => true);
    const options = { companyDirectory: f.company, limits: { workspaceGenerations: 1 }, now: () => now, verify };
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
    verify.mockClear();
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    await lastUsed(path.join(f.workspace, generation(1)), now - 2 * 60 * 60 * 1000);
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(f.workspace)).toEqual([generation(2)]);
  });

  it("never evicts abandoned pending directories and skips verification when only they fill the cache", async () => {
    const f = await fixture(); const now = Date.now(); const verify = vi.fn(async () => true);
    await fs.mkdir(path.join(f.workspace, ".pending-old"), { recursive: true });
    await fs.utimes(path.join(f.workspace, ".pending-old"), new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
      companyDirectory: f.company, limits: { workspaceGenerations: 1 }, now: () => now, verify,
    })).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(await fs.readdir(f.workspace)).toEqual([".pending-old"]);
  });

  it("never returns a cache hit that a concurrent eviction removes", async () => {
    const f = await fixture(); const now = Date.now();
    const options = { companyDirectory: f.company, limits: { workspaceGenerations: 1 }, now: () => now };
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
    await lastUsed(path.join(f.workspace, generation(1)), now - 2 * 60 * 60 * 1000);
    const paused = deferred<void>(), release = deferred<void>();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(".evicted-")) { paused.resolve(); await release.promise; }
      return rename(from, to);
    });
    const publishing = publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options);
    await paused.promise;
    const reading = readWorkspaceSeedGeneration(f.workspace, generation(1), { companyDirectory: f.company });
    await new Promise(resolve => setTimeout(resolve, 200));
    release.resolve();
    const [hit, published] = await Promise.all([reading, publishing]);
    expect(published).toBe(true);
    if (hit) expect(await fs.readFile(hit.workspaceArchivePath, "utf8")).toBe("run recovery bytes");
    else await expect(fs.access(path.join(f.workspace, generation(1)))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not evict from a company directory replaced during verification", async () => {
    const f = await fixture(); const now = Date.now();
    const options = { companyDirectory: f.company, limits: { workspaceGenerations: 1 }, now: () => now };
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
    await lastUsed(path.join(f.workspace, generation(1)), now - 8 * DAY);
    const replacement = path.join(f.root, "other-company");
    await fs.cp(f.company, replacement, { recursive: true, preserveTimestamps: true });
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, { ...options, verify: async () => {
      await fs.rename(f.company, `${f.company}-retained`);
      await fs.symlink(replacement, f.company);
      return true;
    } })).toBe(false);
    expect(await fs.readdir(path.join(replacement, "workspace"))).toEqual([generation(1)]);
  });

  it("removes empty workspace directories so they do not hold workspace slots", async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.company, "abandoned"), { recursive: true });
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, {
      companyDirectory: f.company, limits: { companyWorkspaces: 1 },
    })).toBe(true);
    expect(await fs.readdir(f.company)).toEqual(["workspace"]);
  });

  it("removes leftovers of an interrupted eviction", async () => {
    const f = await fixture(); const options = { companyDirectory: f.company };
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
    await fs.mkdir(path.join(f.workspace, ".evicted-leftover"));
    await fs.writeFile(path.join(f.workspace, ".evicted-leftover", "workspace.tar"), "stale");
    expect(await publishWorkspaceSeedGeneration(f.workspace, generation(2), f.seed, options)).toBe(true);
    expect((await fs.readdir(f.workspace)).sort()).toEqual([generation(1), generation(2)]);
  });
});
