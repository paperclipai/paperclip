import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const observed = vi.hoisted(() => ({
  roots: {} as Record<string, string>, reads: [] as string[], allocations: 0,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    observed.reads.push(String(args[0]));
    return fs.readFileSync(...args);
  } };
});
vi.mock("node:module", async (original) => {
  const mod = await original<typeof import("node:module")>();
  return { ...mod, createRequire: (...args: Parameters<typeof mod.createRequire>) => {
    const require = mod.createRequire(...args);
    const resolve = require.resolve;
    require.resolve = Object.assign((id: string, options?: { paths?: string[] }) =>
      observed.roots[id] ? join(observed.roots[id], "index.js") : resolve(id, options),
    { paths: resolve.paths });
    return require;
  } };
});
vi.mock("@photon-ai/advanced-imessage", () => ({ createGrpcClient: () => {
  observed.allocations++;
  return { close: async () => {} };
} }));

const packages = [
  { name: "@grpc/grpc-js", version: "1.14.5", files: ["build/src/http_proxy.js",
    "build/src/transport.js", "build/src/channel-options.js", "build/src/channel-credentials.js"] },
  { name: "@photon-ai/advanced-imessage", version: "2.2.0", files: ["dist/chunk-5WYZRCOS.js",
    "dist/chunk-EUYUM3KD.js", "dist/client-UZMHAKPA.js"] },
] as const;
let directory: string;
let originals: Map<string, Buffer>;
let artifactPaths: Set<string>;

beforeEach(async () => {
  vi.resetModules();
  observed.roots = {}; observed.reads = []; observed.allocations = 0;
  originals = new Map(); artifactPaths = new Set();
  directory = mkdtempSync(join(tmpdir(), "photon-installed-join-"));
  // Discover bytes from THIS checkout's genuine installed/patch-applied packages.
  // No fake hash, donor checkout or fabricated patched artifact is accepted.
  const { createRequire } = await vi.importActual<typeof import("node:module")>("node:module");
  const require = createRequire(import.meta.url);
  for (const [index, pkg] of packages.entries()) {
    let source = dirname(require.resolve(pkg.name));
    for (let depth = 0; ; depth++, source = dirname(source)) {
      if (depth === 6) throw new Error("Own installed Photon dependency is unavailable");
      try { if (JSON.parse(readFileSync(join(source, "package.json"), "utf8")).name === pkg.name) break; }
      catch { /* Continue the same bounded package-root walk as the owner. */ }
    }
    const root = join(directory, String(index));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), readFileSync(join(source, "package.json")));
    writeFileSync(join(root, "index.js"), "");
    for (const file of pkg.files) {
      const path = join(root, file), bytes = readFileSync(join(source, file));
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
      originals.set(path, bytes); artifactPaths.add(path);
    }
    observed.roots[pkg.name] = root;
  }
  observed.reads = [];
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const artifactReads = () => observed.reads.filter((path) => artifactPaths.has(path));
const client = async () => {
  const owner = await import("../../services/photon/owned-client.js");
  return { owner, allocate: () => owner.createOwnedPhotonClient({ address: "127.0.0.1:1", token: "controlled", tls: true }) };
};

describe("Photon installed transport validation", () => {
  it("reads the seven real artifacts once across repeated shared checks and client allocations", async () => {
    const { owner, allocate } = await client();
    for (let operation = 0; operation < 8; operation++) {
      owner.assertInstalledPhotonTransportJoin();
      const instance = allocate();
      await instance.close();
    }
    console.info(JSON.stringify({ kind: "photon_installed_validation_reads", operations: 8,
      checks: 16, allocations: observed.allocations, artifactReads: artifactReads().length,
      uniqueArtifactReads: new Set(artifactReads()).size }));
    expect(artifactReads()).toHaveLength(7);
    expect(observed.allocations).toBe(8);
    expect(new Set(artifactReads()).size).toBe(7);
    // Original owner: sixteen checks * seven reads = 112. This checks actual
    // dependency work, without a machine-speed threshold or mocked hash result.
  });

  it.each(packages.flatMap((pkg, index) => pkg.files.map((file) => ({ index, file }))))(
    "refuses corrupt $file before allocation and retries the failed validation", async ({ index, file }) => {
      const { allocate } = await client();
      const path = join(observed.roots[packages[index].name], file);
      writeFileSync(path, Buffer.concat([originals.get(path)!, Buffer.from("corrupt")]));
      expect(allocate).toThrow("Photon transport close-and-join delivery is incomplete");
      expect(observed.allocations).toBe(0);
      const position = [...artifactPaths].indexOf(path);
      expect(artifactReads()).toEqual([...artifactPaths].slice(0, position + 1));
      writeFileSync(path, originals.get(path)!); observed.reads = [];
      const instance = allocate();
      expect(artifactReads()).toHaveLength(7);
      await instance.close();
      const again = allocate(); await again.close(); expect(artifactReads()).toHaveLength(7);
    },
  );

  it.each([0, 1])("revalidates changed package root %i and never caches its failure", async (index) => {
    const { allocate } = await client();
    await allocate().close();
    const pkg = packages[index], prior = observed.roots[pkg.name];
    const next = join(directory, `replacement-${index}`);
    mkdirSync(next); writeFileSync(join(next, "package.json"), readFileSync(join(prior, "package.json")));
    writeFileSync(join(next, "index.js"), "");
    for (const file of pkg.files) {
      const path = join(next, file); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(prior, file))); artifactPaths.add(path);
    }
    observed.roots[pkg.name] = next;
    const bad = join(next, pkg.files[0]), bytes = readFileSync(bad);
    writeFileSync(bad, "corrupt"); observed.reads = [];
    expect(allocate).toThrow("Photon transport close-and-join delivery is incomplete");
    expect(observed.allocations).toBe(1);
    writeFileSync(bad, bytes); observed.reads = [];
    await allocate().close(); expect(artifactReads()).toHaveLength(7);
    await allocate().close(); expect(artifactReads()).toHaveLength(7);
  });

  it("does not cache a missing artifact or allocate before a repaired retry", async () => {
    const { allocate } = await client();
    const path = [...artifactPaths][0], bytes = originals.get(path)!;
    rmSync(path);
    expect(allocate).toThrow(/ENOENT/);
    expect(observed.allocations).toBe(0);
    writeFileSync(path, bytes); observed.reads = [];
    await allocate().close(); expect(artifactReads()).toHaveLength(7);
    await allocate().close(); expect(artifactReads()).toHaveLength(7);
  });

  it("keys symlink aliases by the same actual installed roots", async () => {
    const { allocate } = await client(); await allocate().close();
    for (const [index, pkg] of packages.entries()) {
      const alias = join(directory, `alias-${index}`);
      symlinkSync(observed.roots[pkg.name], alias, "dir");
      observed.roots[pkg.name] = alias;
      for (const file of pkg.files) artifactPaths.add(join(alias, file));
    }
    observed.reads = [];
    await allocate().close(); expect(artifactReads()).toHaveLength(0);
  });

  it("still checks versions at a previously successful root", async () => {
    const { allocate } = await client(); await allocate().close();
    const path = join(observed.roots[packages[0].name], "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...pkg, version: "0.0.0" }));
    expect(allocate).toThrow("Photon transport dependency version changed");
    expect(observed.allocations).toBe(1);
  });
});
