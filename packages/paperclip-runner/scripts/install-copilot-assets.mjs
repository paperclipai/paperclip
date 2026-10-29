import { access, lstat, mkdir, readFile, realpath, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COPILOT_DISTRIBUTIONS, materializePinnedCopilotBinary } from "./materialize-copilot-binary.mjs";

const packageRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const owner = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (!["@paperclipai/paperclip-runner", "@paperclipai/server"].includes(owner.name)) {
  throw new Error("Copilot installer must belong to a runner package owner");
}
const vendored = owner.name === "@paperclipai/server";
const runtimeRoot = vendored ? join(packageRoot, "dist/vendor/paperclip-runner") : join(packageRoot, "dist");

/** Install only the native npm package for this platform; never execute it. */
export async function installCopilotAssets() {
  const { platform, arch: architecture } = process;
  const target = `${platform}-${architecture}`;
  if (!Object.prototype.hasOwnProperty.call(COPILOT_DISTRIBUTIONS, target)) {
    return { status: "unsupported-platform", target };
  }
  const verifierPath = join(runtimeRoot, "drivers/acpx/copilot-installation.js");
  try { await access(verifierPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A source workspace installs dependencies before it compiles the verifier.
    // Published packages exclude src, so a malformed npm artifact cannot use
    // this path. build:typescript performs installation after compilation.
    await access(join(packageRoot, vendored ? "src/services/copilot-connection-probe.ts" : "src/drivers/acpx/copilot-installation.ts"));
    await access(resolve(packageRoot, vendored ? "../pnpm-workspace.yaml" : "../../pnpm-workspace.yaml"));
    return { status: "source-workspace-pending-build", target };
  }
  const assets = join(packageRoot, "provider-assets", "copilot");
  for (const directory of [dirname(assets), assets]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error("Copilot install directory must not redirect through links");
    }
  }
  const destination = join(assets, target);
  const originalRoot = process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT;
  const originalManifest = process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST;
  process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT = packageRoot;
  process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST = join(packageRoot, "package.json");
  try {
    const { COPILOT_CLOSURE_SHA256, verifyCopilotInstallation } = await import(pathToFileURL(join(runtimeRoot, "drivers/acpx/copilot-installation.js")));
    const { QUALIFIED_ACPX_PROFILES } = await import(pathToFileURL(join(runtimeRoot, "drivers/acpx/qualified-profiles.js")));
    const verify = () => verifyCopilotInstallation(QUALIFIED_ACPX_PROFILES.copilot);
    try { await mkdir(destination, { mode: 0o755 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(destination) !== destination) {
        throw new Error("Copilot installed assets must not redirect through links");
      }
      await verify();
      return { status: "verified-existing", target };
    }
    const ownedDirectory = await lstat(destination, { bigint: true });
    try {
      // Official native packages export their executable, not package.json.
      // Resolve that path without loading or executing the native module.
      const nativePackageRoot = dirname(createRequire(import.meta.url).resolve(COPILOT_DISTRIBUTIONS[target].packageName));
      const materialized = materializePinnedCopilotBinary({ packageRoot: nativePackageRoot, platform, architecture, targetDirectory: destination });
      if (materialized.closureSha256 !== COPILOT_CLOSURE_SHA256[target]) {
        throw new Error("Copilot installation differs from the runtime closure pin");
      }
      await verify();
      return { status: "installed", target };
    } catch (error) {
      // The materializer rolls back only files it created. Remove this newly
      // created directory only if it is now empty; retain foreign files or
      // failed verification evidence rather than deleting a directory tree.
      try {
        const current = await lstat(destination, { bigint: true });
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === ownedDirectory.dev && current.ino === ownedDirectory.ino) await rmdir(destination);
      }
      catch (cleanupError) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(cleanupError.code)) throw new AggregateError([error, cleanupError], "Copilot install and empty-directory cleanup failed"); }
      throw error;
    }
  } finally {
    for (const [key, value] of [["PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", originalRoot], ["PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", originalManifest]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const result = await installCopilotAssets();
  process.stdout.write(`Copilot runtime assets: ${result.status} (${result.target})\n`);
}
