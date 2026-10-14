import fs from "node:fs/promises";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publishWorkspaceSeedGeneration, readWorkspaceSeedGeneration } from "./workspace-seed-cache.js";

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

it("applies the company byte cap across workspace roots", async () => {
  const f = await fixture();
  const options = { companyDirectory: f.company, limits: { companyBytes: 4500 } };
  expect(await publishWorkspaceSeedGeneration(f.workspace, generation(1), f.seed, options)).toBe(true);
  const secondArchive = path.join(f.root, "second-seed.tar"); await fs.writeFile(secondArchive, "x".repeat(1000));
  expect(await publishWorkspaceSeedGeneration(path.join(f.company, "second"), generation(2), { workspaceArchivePath: secondArchive }, options)).toBe(false);
  expect(await fs.readdir(f.company)).toEqual(["workspace"]);
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
