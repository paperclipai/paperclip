import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPluginsUnder } from "./link-plugin-dev-sdk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function cachePlan({ files, read, scope, packageDirs }) {
  const dependencyInputs = files.filter((file) =>
    /(^|\/)package\.json$/.test(file)
    || ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs"].includes(file)
    || file.startsWith("scripts/")
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
      scripts[hook] === undefined || (directory === '.' && hook === 'postinstall'
        && scripts[hook] === 'node scripts/link-plugin-dev-sdk.mjs'));
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
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
  const command = (args) => execFileSync("pnpm", args, { cwd: root, encoding: "utf8" }).trim();
  const workspaces = JSON.parse(command(['-r', 'list', '--depth=-1', '--json']));
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
      pnpm: command(["--version"]), store: command(["store", "path", "--silent"]),
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
