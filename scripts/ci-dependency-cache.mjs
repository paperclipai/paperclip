import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readPluginsUnder } from "./link-plugin-dev-sdk.mjs";

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const postinstallHooks = new Map([
  [".", "node scripts/link-plugin-dev-sdk.mjs"],
  ["server", "node scripts/install-copilot-assets.mjs"],
  ["packages/paperclip-runner", "node scripts/install-copilot-assets.mjs"],
]);

export const DEPENDENCY_SCRIPT_INPUTS = new Set([
  "scripts/ci-dependency-cache.mjs",
  "scripts/link-plugin-dev-sdk.mjs",
  "scripts/ensure-workspace-package-links.mjs",
  "scripts/replay-workspace-postinstall.mjs",
  "server/scripts/install-copilot-assets.mjs",
  "packages/paperclip-runner/scripts/install-copilot-assets.mjs",
  "packages/paperclip-runner/scripts/materialize-copilot-binary.mjs",
  "packages/paperclip-runner/scripts/copilot-inner-distribution.mjs",
]);

export function cachePlan({ files, read, scope, packageDirs }) {
  const dependencyInputs = files.filter((file) =>
    /(^|\/)package\.json$/.test(file)
    || ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs"].includes(file)
    || DEPENDENCY_SCRIPT_INPUTS.has(file)
    || file.startsWith("patches/"));
  const digest = (inputs, salt) => {
    const hash = createHash("sha256").update(JSON.stringify(salt));
    for (const file of [...inputs].sort()) {
      const bytes = read(file);
      hash.update(JSON.stringify([file, bytes === null ? null : bytes.length]));
      if (bytes !== null) hash.update(bytes);
    }
    return hash.digest("hex");
  };
  const dependencyKey = `ci-dependencies-v1-${digest(dependencyInputs, scope)}`;
  const cacheable = packageDirs.every((directory) => {
    const manifest = read(path.posix.join(directory, 'package.json'));
    if (manifest === null) return false;
    const scripts = JSON.parse(manifest).scripts ?? {};
    return ['preinstall', 'install', 'postinstall', 'prepare'].every((hook) =>
      scripts[hook] === undefined || (hook === 'postinstall'
        && scripts[hook] === postinstallHooks.get(directory)));
  });
  const buildInputs = files.filter((file) =>
    file.startsWith("packages/shared/") || file.startsWith("packages/plugins/sdk/")
    || /^tsconfig[^/]*\.json$/.test(file)
    || file === "scripts/ensure-plugin-build-deps.mjs");
  return {
    cacheable,
    dependencyKey,
    buildKey: `ci-build-dependencies-v1-${digest(buildInputs, dependencyKey)}`,
    dependencyPaths: [...new Set(packageDirs.map((directory) => {
      if (path.isAbsolute(directory) || directory.split('/').includes('..')) throw new Error('Package directory escapes the checkout');
      return path.posix.join(directory, 'node_modules');
    }))].sort(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = (bin, args) =>
    execFileAsync(bin, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout);
  const [gitFilesRaw, workspacesRaw, pnpmVersionRaw, pnpmStoreRaw] = await Promise.all([
    command("git", ["ls-files", "-z"]),
    command("pnpm", ["-r", "list", "--depth=-1", "--json"]),
    command("pnpm", ["--version"]),
    command("pnpm", ["store", "path", "--silent"]),
  ]);
  const files = gitFilesRaw.split("\0").filter(Boolean);
  const workspaces = JSON.parse(workspacesRaw.trim());
  const packageDirs = ['.',
    ...workspaces.map((workspace) => path.relative(root, workspace.path).split(path.sep).join('/') || '.'),
    ...readPluginsUnder(path.join(root, 'packages/plugins/sandbox-providers')).map((directory) => path.relative(root, directory).split(path.sep).join('/')),
    'packages/plugins/examples/plugin-orchestration-smoke-example',
  ];
  const plan = cachePlan({
    files,
    read: (file) => existsSync(path.join(root, file)) ? readFileSync(path.join(root, file)) : null,
    packageDirs,
    scope: {
      root: realpathSync(root), node: process.version, abi: process.versions.modules,
      platform: process.platform, arch: process.arch,
      libc: process.report.getReport().header.glibcVersionRuntime ?? null,
      pnpm: pnpmVersionRaw.trim(), store: pnpmStoreRaw.trim(),
    },
  });
  const output = [
    `cacheable=${plan.cacheable}`,
    `dependency-key=${plan.dependencyKey}`,
    `build-key=${plan.buildKey}`,
    "dependency-paths<<PAPERCLIP_CACHE_PATHS",
    ...plan.dependencyPaths.map((file) => path.join(root, file)),
    "PAPERCLIP_CACHE_PATHS",
    "build-paths<<PAPERCLIP_BUILD_PATHS",
    path.join(root, "packages/shared/dist"),
    path.join(root, "packages/plugins/sdk/dist"),
    "PAPERCLIP_BUILD_PATHS",
  ].join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else console.log(JSON.stringify(plan, null, 2));
}
