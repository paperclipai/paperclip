import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { provisionPackageRoot, provisionPi } from "../../../scripts/provision-pi.mjs";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), build: vi.fn(), close: vi.fn(), beforeMkdir: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => { await mocks.beforeMkdir(...args); return actual.mkdir(...args); } };
});
vi.mock("./pi-installation.ts", () => ({ verifyPiInstallation: mocks.verify }));
vi.mock("../../../scripts/materialize-pi-distribution.mjs", () => ({ materializePiDistribution: mocks.build }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.beforeMkdir.mockReset();
  mocks.verify.mockImplementation(async () => ({ openCommand: async () => ({ close: mocks.close }) }));
  mocks.build.mockImplementation(async ({ outputRoot }: { outputRoot: string }) => { await mkdir(outputRoot, { recursive: true }); await writeFile(join(outputRoot, "owned"), "fixture"); });
});
async function fixture(vendored = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-provision-")); roots.push(root);
  const cli = join(root, vendored ? "dist/vendor/paperclip-runner/cli" : "dist/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: vendored ? "@paperclipai/server" : "@paperclipai/paperclip-runner" }));
  const entry = join(cli, "provision-pi.cjs"); await writeFile(entry, "fixture");
  return { root, cli, entry, parent: join(root, "provider-assets/pi"), output: join(root, "provider-assets/pi", `${process.platform}-${process.arch}`) };
}
it("recognizes both published layouts without resolving a private npm package", async () => {
  for (const vendored of [true, false]) { const f = await fixture(vendored); expect((await provisionPackageRoot(f.entry)).root).toBe(f.root); }
});
it("rejects wrong package, linked entrypoint and escaping asset roots before materialization", async () => {
  const f = await fixture(); const other = await fixture();
  await writeFile(join(f.root, "package.json"), '{"name":"foreign"}');
  await expect(provisionPi(f.entry)).rejects.toThrow("identity");
  await writeFile(join(f.root, "package.json"), '{"name":"@paperclipai/server"}');
  await rm(f.entry); await symlink(other.entry, f.entry);
  await expect(provisionPi(f.entry)).rejects.toThrow("linked");
  await rm(f.entry); await writeFile(f.entry, "fixture"); await symlink(other.root, join(f.root, "provider-assets"));
  await expect(provisionPi(f.entry)).rejects.toThrow("escapes");
  expect(mocks.build).not.toHaveBeenCalled();
});
it("verifies an existing cache in full and never repairs a rejected cache automatically", async () => {
  const f = await fixture(); await mkdir(f.output, { recursive: true }); await writeFile(join(f.output, "original"), "retain");
  expect(await provisionPi(f.entry)).toMatchObject({ status: "verified_existing" });
  mocks.verify.mockRejectedValueOnce(new Error("closure differs"));
  await expect(provisionPi(f.entry)).rejects.toThrow("closure differs");
  expect(await readFile(join(f.output, "original"), "utf8")).toBe("retain");
  expect(mocks.build).not.toHaveBeenCalled(); expect(await readdir(f.parent)).toEqual([`${process.platform}-${process.arch}`]);
});
it("publishes only after staging verification, then verifies the actual package authority", async () => {
  const f = await fixture(); vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "untrusted-ambient");
  expect(await provisionPi(f.entry)).toMatchObject({ status: "installed_verified" });
  expect(mocks.verify).toHaveBeenCalledTimes(2); expect(mocks.close).toHaveBeenCalledTimes(2);
  expect(process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT).toBe("untrusted-ambient");
  expect(await readdir(f.parent)).toEqual([`${process.platform}-${process.arch}`]);
});
it.each(["build", "staging", "published"])("cleans only its owned transaction after %s failure", async stage => {
  const f = await fixture();
  if (stage === "build") mocks.build.mockRejectedValueOnce(new Error("failed"));
  if (stage === "staging") mocks.verify.mockRejectedValueOnce(new Error("failed"));
  if (stage === "published") mocks.verify.mockResolvedValueOnce({ openCommand: async () => ({ close: mocks.close }) }).mockRejectedValueOnce(new Error("failed"));
  await expect(provisionPi(f.entry)).rejects.toThrow("failed");
  expect(await readdir(f.parent)).toEqual([]);
});
it("refuses a concurrent setup without deleting its lock or launching work", async () => {
  const f = await fixture(); await mkdir(f.parent, { recursive: true });
  const name = `.setup-${process.platform}-${process.arch}.lock`; await writeFile(join(f.parent, name), "other");
  await expect(provisionPi(f.entry)).rejects.toThrow(); expect(mocks.build).not.toHaveBeenCalled();
  expect(await readFile(join(f.parent, name), "utf8")).toBe("other");
});
it("honors cancellation after owned materialization without publishing or leaving temporary files", async () => {
  const f = await fixture(); let cancelled = false;
  mocks.build.mockImplementationOnce(async ({ outputRoot }: { outputRoot: string }) => { await mkdir(outputRoot, { recursive: true }); cancelled = true; });
  await expect(provisionPi(f.entry, () => { if (cancelled) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(await readdir(f.parent)).toEqual([]);
});

it("does not replace an empty destination that appears during preparation", async () => {
  const f = await fixture();
  mocks.verify.mockImplementationOnce(async () => { await mkdir(f.output); return { openCommand: async () => ({ close: mocks.close }) }; });
  await expect(provisionPi(f.entry)).rejects.toThrow("destination appeared");
  expect(await readdir(f.output)).toEqual([]);
});
it("retains a replaced staging root while still releasing its own lock", async () => {
  const f = await fixture();
  let moved: string | undefined;
  mocks.build.mockImplementationOnce(async ({ outputRoot }: { outputRoot: string }) => {
    const temporary = outputRoot.slice(0, outputRoot.indexOf("/package/provider-assets/"));
    moved = `${temporary}-original`; await rename(temporary, moved);
    await mkdir(temporary); await writeFile(join(temporary, "foreign"), "retain");
    throw new Error("materialization failed");
  });
  await expect(provisionPi(f.entry)).rejects.toThrow("cleanup failed");
  const names = await readdir(f.parent);
  expect(names.some(name => name.endsWith(".lock"))).toBe(false);
  const replaced = names.find(name => !name.endsWith("-original"))!;
  expect(await readFile(join(f.parent, replaced, "foreign"), "utf8")).toBe("retain");
  expect(moved).toBeDefined(); // fixture teardown owns both test-created roots
});

it("uses exclusive publication when an empty target appears after the absence check", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  mocks.beforeMkdir.mockImplementationOnce(() => undefined);
  mocks.beforeMkdir.mockImplementation(async (path: unknown) => {
    if (path === f.output) { mocks.beforeMkdir.mockReset(); await actual.mkdir(f.output); }
  });
  await expect(provisionPi(f.entry)).rejects.toThrow(/EEXIST/);
  expect(await readdir(f.output)).toEqual([]);
  expect(await readdir(f.parent)).toEqual([`${process.platform}-${process.arch}`]);
});
