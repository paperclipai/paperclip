import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({ assets: "", verify: vi.fn() }));
vi.mock("./provider-assets-root.js", async original => {
  const actual = await original<typeof import("./provider-assets-root.js")>();
  return { ...actual, resolveRunnerProviderAssetsRoot: (...args: Parameters<typeof actual.resolveRunnerProviderAssetsRoot>) =>
    args[2]?.providerPackageRoot === undefined ? setup.assets : actual.resolveRunnerProviderAssetsRoot(...args) };
});
vi.mock("./installation-integrity.js", async original => ({
  ...await original<typeof import("./installation-integrity.js")>(), verifyNativeAcpxInstallation: setup.verify,
}));
import { startAntigravityBrowserLogin } from "./antigravity-auth.js";
import { antigravityNativeDistributionSpec, antigravityProviderPackRoot, antigravityRuntimeCachePath, verifyAntigravityInstallation } from "./antigravity-installation.js";
import { discoverAntigravityModels } from "./antigravity-models.js";
import { AntigravityRuntimeUnavailableError } from "./antigravity-runtime-unavailable.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "./generated-profiles.js";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";

const PACK_ENV = "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH";
const target = `${process.platform}-${process.arch}`;
const pinned = Object.hasOwn(ANTIGRAVITY_DISTRIBUTION_PINS, target);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-installation-"))); roots.push(root);
  setup.assets = join(root, "server-vendor", "provider-assets", "antigravity");
  const pack = join(root, "provider-pack");
  await mkdir(pack);
  await writeFile(join(pack, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }));
  return { root, pack, packed: (key: string) => join(pack, "provider-assets", "antigravity", key) };
}

describe("Antigravity runtime resolution", () => {
  it("uses the deployment's build-owned provider pack when the server package carries no packaged runtime", async () => {
    const { pack, packed } = await layout();
    await mkdir(packed("linux-x64"), { recursive: true });
    vi.stubEnv(PACK_ENV, ` ${pack}/ `);
    const spec = antigravityNativeDistributionSpec("linux", "x64");
    expect(spec.distributionRoot).toBe(packed("linux-x64"));
    expect(spec.manifestPath).toBe(join(packed("linux-x64"), ".paperclip-antigravity-closure.json"));
    expect(spec.expectedClosureSha256).toBe(ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256);
  });

  it("prefers the packaged runtime over the provider pack", async () => {
    const { pack, packed } = await layout();
    await mkdir(packed("linux-x64"), { recursive: true });
    await mkdir(join(setup.assets, "linux-x64"), { recursive: true });
    vi.stubEnv(PACK_ENV, pack);
    expect(antigravityNativeDistributionSpec("linux", "x64").distributionRoot).toBe(join(setup.assets, "linux-x64"));
  });

  it("falls back to the account runtime cache when no provider pack carries this target", async () => {
    const { pack } = await layout();
    const cache = antigravityRuntimeCachePath(ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256, "linux", "x64", userInfo().homedir);
    vi.stubEnv(PACK_ENV, pack);
    expect(antigravityNativeDistributionSpec("linux", "x64").distributionRoot).toBe(cache);
    vi.stubEnv(PACK_ENV, "");
    expect(antigravityNativeDistributionSpec("linux", "x64").distributionRoot).toBe(cache);
  });

  it("refuses a provider pack runtime reached through a link or a relative root", async () => {
    const { root, pack } = await layout();
    await mkdir(join(root, "elsewhere", "linux-x64"), { recursive: true });
    await mkdir(join(pack, "provider-assets"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(pack, "provider-assets", "antigravity"));
    vi.stubEnv(PACK_ENV, pack);
    expect(() => antigravityNativeDistributionSpec("linux", "x64")).toThrow(/not contained by its package/);
    expect(() => antigravityProviderPackRoot({ [PACK_ENV]: "provider-pack" })).toThrow(/normalized absolute path/);
    expect(() => antigravityProviderPackRoot({ [PACK_ENV]: "/opt/paperclip-runner/../etc" })).toThrow(/normalized absolute path/);
    expect(antigravityProviderPackRoot({ [PACK_ENV]: " /opt/paperclip-runner/provider-pack/ " })).toBe("/opt/paperclip-runner/provider-pack");
    expect(antigravityProviderPackRoot({})).toBeUndefined();
  });

  it.runIf(pinned)("binds sign-in, model discovery and installation verification to the same provider pack", async () => {
    const { root, pack, packed } = await layout();
    await mkdir(packed(target), { recursive: true });
    vi.stubEnv(PACK_ENV, pack);
    const resolved: string[] = [];
    setup.verify.mockImplementation(async (spec: { distributionRoot: string }) => { resolved.push(spec.distributionRoot); throw new Error("fixture closure absent"); });
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });

    const onFailure = vi.fn();
    const login = startAntigravityBrowserLogin(home, { onFailure });
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("runtime_unavailable");
    await expect(discoverAntigravityModels(home)).rejects.toBeInstanceOf(AntigravityRuntimeUnavailableError);
    await expect(verifyAntigravityInstallation({ ...QUALIFIED_ACPX_PROFILES.antigravity, qualificationModel: "fixture-model", reportedModelId: "fixture-model" }))
      .rejects.toThrow("fixture closure absent");
    expect(resolved).toEqual([packed(target), packed(target), packed(target)]);
  });
});
