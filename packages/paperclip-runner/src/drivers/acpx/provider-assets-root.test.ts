import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), "runner-provider-assets-"))); roots.push(path); return path; }

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
  await mkdir(join(vendored, "cli"), { recursive: true });
  await writeFile(join(vendored, "cli/acpx-runtime-sidecar.cjs"), "// bundled sidecar");
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
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "cursor")).toThrow("escaped");
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

async function serverFixture() {
  const path = await root();
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  await mkdir(join(path, "dist/vendor/paperclip-runner/cli"), { recursive: true });
  await writeFile(join(path, "dist/vendor/paperclip-runner/cli/acpx-runtime-sidecar.cjs"), "// bundled sidecar");
  return path;
}
it("admits the public server's exact vendored layout for readiness and descriptor execution", async () => {
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", undefined);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", undefined);
  const path = await serverFixture();
  const url = pathToFileURL(join(path, "dist/vendor/paperclip-runner/drivers/acpx/pi-installation.js")).href;
  expect(resolveRunnerProviderAssetsRoot(url, "pi")).toBe(join(path, "dist/vendor/paperclip-runner/provider-assets/pi"));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", path);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "package.json"));
  expect(resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "pi")).toBe(join(path, "dist/vendor/paperclip-runner/provider-assets/pi"));
});
it("rejects an unrelated server manifest, escaped vendor sidecar and linked manifest", async () => {
  const path = await serverFixture(); const outside = await root();
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", path);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "package.json"));
  await mkdir(join(path, "nested"));
  await writeFile(join(path, "nested/package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "nested/package.json"));
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "pi")).toThrow("outside its package root");
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(path, "package.json"));
  await rm(join(path, "dist/vendor/paperclip-runner/cli"), { recursive: true });
  await symlink(outside, join(path, "dist/vendor/paperclip-runner/cli"));
  expect(() => resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", "pi")).toThrow("escaped");
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", undefined);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", undefined);
  await rm(join(path, "package.json"));
  await writeFile(join(outside, "package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  await symlink(join(outside, "package.json"), join(path, "package.json"));
  expect(() => resolveRunnerProviderAssetsRoot(pathToFileURL(join(path, "dist/vendor/paperclip-runner/drivers/acpx/pi-installation.js")).href, "pi")).toThrow();
});
