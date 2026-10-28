import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type NativeProvider = "cursor" | "copilot" | "pi";
const RUNNER_PACKAGE_NAME = "@paperclipai/paperclip-runner";
const SERVER_PACKAGE_NAME = "@paperclipai/server";
function assertServerVendorLayout(root: string): void {
  const sidecar = join(root, "dist/vendor/paperclip-runner/cli/acpx-runtime-sidecar.cjs");
  for (const part of ["dist", "dist/vendor", "dist/vendor/paperclip-runner", "dist/vendor/paperclip-runner/cli"]) {
    const path = join(root, part); const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Runner server vendor layout escaped its package");
  }
  const info = lstatSync(sidecar);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(sidecar) !== sidecar) throw new Error("Runner server vendor sidecar is invalid");
}

/** Resolve only runner-owned package assets, including descriptor-loaded sidecars. */
export function resolveRunnerProviderAssetsRoot(moduleUrl: string, provider: NativeProvider): string {
  if (!["cursor", "copilot", "pi"].includes(provider)) throw new Error("Unknown native ACP provider assets");
  const boundRoot = process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT;
  const boundManifest = process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST;
  let packageRoot: string;
  if (boundRoot !== undefined) {
    const root = normalizedAbsolute(boundRoot);
    const manifest = normalizedAbsolute(boundManifest ?? join(root, "package.json"));
    packageRoot = realpathSync(root);
    const canonicalManifest = realpathSync(manifest);
    if (!inside(packageRoot, canonicalManifest)) throw new Error("Runner provider manifest escapes its bound package root");
    // The authority comes from runnerd's selected provider pack, never provider
    // environment. Verify the selected manifest itself before deriving assets.
    const fd = openSync(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > 64n * 1024n) throw new Error("Runner provider manifest is not a bounded regular file");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || bytes.length !== Number(before.size) || realpathSync(manifest) !== canonicalManifest) throw new Error("Runner provider manifest changed during admission");
      const value = JSON.parse(bytes.toString("utf8")) as { name?: unknown };
      if (canonicalManifest !== join(packageRoot, "package.json")) throw new Error("Runner provider manifest is outside its package root");
      if (value?.name === "@paperclipai/server") {
        assertServerVendorLayout(packageRoot);
        // runnerd derives this binding from the verified sidecar in the public
        // server package. Images may carry assets alongside that bundle; local
        // explicit setup uses the OS-account cache when package assets are absent.
        packageRoot = provider === "copilot" ? dirname(canonicalManifest) : join(dirname(canonicalManifest), "dist/vendor/paperclip-runner");
        if (realpathSync(packageRoot) !== packageRoot) throw new Error("Vendored runner directory is not contained by its server package");
      } else if (value?.name === RUNNER_PACKAGE_NAME) {
        packageRoot = dirname(canonicalManifest);
      } else throw new Error("Runner provider manifest does not name the runner or server package");
    } finally { closeSync(fd); }
  } else {
    if (boundManifest !== undefined) throw new Error("Runner provider manifest has no bound package root");
    const url = new URL(moduleUrl);
    if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Provider factory is outside a verified package layout");
    if (new RegExp(`/dist/vendor/paperclip-runner/drivers/acpx/${provider}-installation\\.js$`).test(url.pathname)) {
      packageRoot = realpathSync(fileURLToPath(new URL("../../../../../", url)));
      const manifest = join(packageRoot, "package.json");
      const metadata = readPackageManifest(manifest, manifest);
      if (metadata.name !== SERVER_PACKAGE_NAME) throw new Error("Runner server vendor package identity is invalid");
      assertServerVendorLayout(packageRoot);
      if (provider !== "copilot") packageRoot = join(packageRoot, "dist/vendor/paperclip-runner");
    } else if (new RegExp(`/(?:src|dist)/drivers/acpx/${provider}-installation\\.(?:ts|js)$`).test(url.pathname)) packageRoot = fileURLToPath(new URL("../../../", url));
    else if (/\/dist\/cli\/acpx-runtime-sidecar\.(?:cjs|js)$/.test(url.pathname)) packageRoot = fileURLToPath(new URL("../../", url));
    else if (new RegExp(`/dist/vendor/paperclip-runner/drivers/acpx/${provider}-installation\\.(?:js)$`).test(url.pathname)) packageRoot = fileURLToPath(new URL("../../", url));
    else if (/\/dist\/vendor\/paperclip-runner\/cli\/acpx-runtime-sidecar\.(?:cjs|js)$/.test(url.pathname)) packageRoot = fileURLToPath(new URL("../", url));
    else throw new Error("Provider factory is outside a verified package layout");
    packageRoot = realpathSync(packageRoot);
  }
  const assets = join(packageRoot, "provider-assets", provider);
  // Missing materialization is diagnosed by the installation verifier. Existing
  // directory components must not redirect discovery outside this package.
  for (const path of [join(packageRoot, "provider-assets"), assets]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(packageRoot, realpathSync(path))) throw new Error("Runner provider asset directory is not contained by its package");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return assets;
}

function normalizedAbsolute(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || resolve(value) !== value) throw new Error("Runner provider package authority must be a normalized absolute path");
  return value;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readPackageManifest(manifest: string, canonicalManifest: string): { name?: unknown } {
  const fd = openSync(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 64n * 1024n) throw new Error("Runner provider manifest is not a bounded regular file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(manifest, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()
      || bytes.length !== Number(before.size) || realpathSync(manifest) !== canonicalManifest) throw new Error("Runner provider manifest changed during admission");
    return JSON.parse(bytes.toString("utf8")) as { name?: unknown };
  } finally { closeSync(fd); }
}
