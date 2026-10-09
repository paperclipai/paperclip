import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "runner-provider-assets-")); roots.push(path); return path; }

it("uses one fixed provider directory for source, compiled and bundled runner layouts", async () => {
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", undefined);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", undefined);
  const path = await root();
  for (const relative of ["src/drivers/acpx/cursor-installation.ts", "dist/drivers/acpx/cursor-installation.js", "dist/cli/acpx-runtime-sidecar.cjs"]) {
    expect(resolveRunnerProviderAssetsRoot(pathToFileURL(join(path, relative)).href, "cursor")).toMatch(/provider-assets\/cursor$/);
  }
  expect(() => resolveRunnerProviderAssetsRoot(pathToFileURL(join(path, "workspace/arbitrary.ts")).href, "cursor")).toThrow("verified package layout");
});

it("resolves descriptor sidecars only through the runner-bound canonical package manifest", async () => {
  const path = await root();
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", path);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "package.json"));
  expect(resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "pi")).toMatch(/provider-assets\/pi$/);
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "untrusted" }));
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "pi")).toThrow("runner or server package");
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "relative");
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "pi")).toThrow("normalized absolute");
});

it("resolves the public server bundle without repository paths or candidate overrides", async () => {
  const path = await root();
  const vendored = join(await realpath(path), "dist/vendor/paperclip-runner");
  await mkdir(vendored, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", path);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "package.json"));
  expect(resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "cursor")).toBe(join(vendored, "provider-assets/cursor"));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", undefined);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", undefined);
  for (const relative of ["drivers/acpx/cursor-installation.js", "cli/acpx-runtime-sidecar.cjs"]) {
    expect(resolveRunnerProviderAssetsRoot(pathToFileURL(join(vendored, relative)).href, "cursor")).toBe(join(vendored, "provider-assets/cursor"));
  }
});

it("rejects a server bundle redirected outside its published package", async () => {
  const path = await root(); const outside = await root();
  await mkdir(join(path, "dist/vendor"), { recursive: true });
  await symlink(outside, join(path, "dist/vendor/paperclip-runner"));
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", path);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "package.json"));
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "cursor")).toThrow("contained");
});

it("rejects external manifests, links, asset escapes and incomplete authority", async () => {
  const path = await root(); const outside = await root();
  await writeFile(join(outside, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", path);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(outside, "package.json"));
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "copilot")).toThrow("escapes");
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "package.json"));
  await mkdir(join(path, "provider-assets"));
  await symlink(outside, join(path, "provider-assets/copilot"));
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "copilot")).toThrow("contained");
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", undefined);
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "copilot")).toThrow("no bound");
});
