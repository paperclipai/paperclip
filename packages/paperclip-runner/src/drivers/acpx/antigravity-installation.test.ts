import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const assets = vi.hoisted(() => ({ root: "" }));
vi.mock("./provider-assets-root.js", () => ({ resolveRunnerProviderAssetsRoot: () => assets.root }));
import { antigravityNativeDistributionSpec, antigravityRuntimeCachePath } from "./antigravity-installation.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "./generated-profiles.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-installation-"))); roots.push(root);
  assets.root = join(root, "server-vendor", "provider-assets", "antigravity");
  const pack = join(root, "provider-pack");
  return { root, pack, packed: join(pack, "provider-assets", "antigravity", "linux-x64") };
}

describe("Antigravity runtime resolution", () => {
  it("uses the build-owned provider pack when the server package carries no packaged runtime", async () => {
    const { pack, packed } = await layout();
    await mkdir(packed, { recursive: true });
    const spec = antigravityNativeDistributionSpec("linux", "x64", { providerPackRoot: pack });
    expect(spec.distributionRoot).toBe(packed);
    expect(spec.manifestPath).toBe(join(packed, ".paperclip-antigravity-closure.json"));
    expect(spec.expectedClosureSha256).toBe(ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256);
  });

  it("prefers the packaged runtime over the provider pack", async () => {
    const { pack, packed } = await layout();
    await mkdir(packed, { recursive: true });
    await mkdir(join(assets.root, "linux-x64"), { recursive: true });
    expect(antigravityNativeDistributionSpec("linux", "x64", { providerPackRoot: pack }).distributionRoot).toBe(join(assets.root, "linux-x64"));
  });

  it("falls back to the account runtime cache when the provider pack has no runtime for this target", async () => {
    const { pack } = await layout();
    await mkdir(pack, { recursive: true });
    const cache = antigravityRuntimeCachePath(ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256, "linux", "x64", userInfo().homedir);
    expect(antigravityNativeDistributionSpec("linux", "x64", { providerPackRoot: pack }).distributionRoot).toBe(cache);
    expect(antigravityNativeDistributionSpec("linux", "x64").distributionRoot).toBe(cache);
  });

  it("refuses a provider pack runtime reached through a link or a relative root", async () => {
    const { root, pack } = await layout();
    const elsewhere = join(root, "elsewhere", "linux-x64");
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(pack, "provider-assets"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(pack, "provider-assets", "antigravity"));
    expect(() => antigravityNativeDistributionSpec("linux", "x64", { providerPackRoot: pack })).toThrow(/real directories/);
    expect(() => antigravityNativeDistributionSpec("linux", "x64", { providerPackRoot: "provider-pack" })).toThrow(/normalized absolute path/);
  });
});
