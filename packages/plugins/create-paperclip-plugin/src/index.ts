#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_TEMPLATES = ["default", "connector", "workspace"] as const;
type PluginTemplate = (typeof VALID_TEMPLATES)[number];
const VALID_CATEGORIES = new Set(["connector", "workspace", "automation", "ui"] as const);

export interface ScaffoldPluginOptions {
  pluginName: string;
  outputDir: string;
  template?: PluginTemplate;
  displayName?: string;
  description?: string;
  author?: string;
  category?: "connector" | "workspace" | "automation" | "ui";
  sdkPath?: string;
}

/** Validate npm-style plugin package names (scoped or unscoped). */
export function isValidPluginName(name: string): boolean {
  const scopedPattern = /^@[a-z0-9_-]+\/[a-z0-9._-]+$/;
  const unscopedPattern = /^[a-z0-9._-]+$/;
  return scopedPattern.test(name) || unscopedPattern.test(name);
}

/** Convert `@scope/name` to an output directory basename (`name`). */
function packageToDirName(pluginName: string): string {
  return pluginName.replace(/^@[^/]+\//, "");
}

/** Convert an npm package name into a manifest-safe plugin id. */
function packageToManifestId(pluginName: string): string {
  if (!pluginName.startsWith("@")) {
    return pluginName;
  }

  return pluginName.slice(1).replace("/", ".");
}

/** Build a human-readable display name from package name tokens. */
function makeDisplayName(pluginName: string): string {
  const raw = packageToDirName(pluginName).replace(/[._-]+/g, " ").trim();
  return raw
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function writeFile(target: string, content: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function formatFileDependency(absPath: string): string {
  return `file:${toPosixPath(path.resolve(absPath))}`;
}

function getLocalSdkPackagePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "sdk");
}

function getRepoRootFromSdkPath(sdkPath: string): string {
  return path.resolve(sdkPath, "..", "..", "..");
}

function getLocalSharedPackagePath(sdkPath: string): string {
  return path.resolve(getRepoRootFromSdkPath(sdkPath), "packages", "shared");
}

function isInsideDir(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packLocalPackage(packagePath: string, outputDir: string): string {
  const packageJsonPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Package package.json not found at ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };
  const packageName = packageJson.name ?? path.basename(packagePath);
  const packageVersion = packageJson.version ?? "0.0.0";
  const tarballFileName = `${packageName.replace(/^@/, "").replace("/", "-")}-${packageVersion}.tgz`;
  const sdkBundleDir = path.join(outputDir, ".paperclip-sdk");

  fs.mkdirSync(sdkBundleDir, { recursive: true });
  execFileSync("pnpm", ["build"], { cwd: packagePath, stdio: "pipe" });
  execFileSync("pnpm", ["pack", "--pack-destination", sdkBundleDir], { cwd: packagePath, stdio: "pipe" });

  const tarballPath = path.join(sdkBundleDir, tarballFileName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Packed tarball was not created at ${tarballPath}`);
  }

  return tarballPath;
}

/**
 * Generate a complete Paperclip plugin starter project.
 *
 * Output includes manifest/worker/UI entries, SDK harness tests, bundler presets,
 * and a local dev server script for hot-reload workflow.
 */
export function scaffoldPluginProject(options: ScaffoldPluginOptions): string {
  const template = options.template ?? "default";
  if (!VALID_TEMPLATES.includes(template)) {
    throw new Error(`Invalid template '${template}'. Expected one of: ${VALID_TEMPLATES.join(", ")}`);
  }

  if (!isValidPluginName(options.pluginName)) {
    throw new Error("Invalid plugin name. Must be lowercase and may include scope, dots, underscores, or hyphens.");
  }

  if (options.category && !VALID_CATEGORIES.has(options.category)) {
    throw new Error(`Invalid category '${options.category}'. Expected one of: ${[...VALID_CATEGORIES].join(", ")}`);
  }

  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(outputDir)) {
    throw new Error(`Directory already exists: ${outputDir}`);
  }

  const displayName = options.displayName ?? makeDisplayName(options.pluginName);
  const description = options.description ?? "A Paperclip plugin";
  const author = options.author ?? "Plugin Author";
  const category = options.category ?? (template === "workspace" ? "workspace" : "connector");
  const manifestId = packageToManifestId(options.pluginName);
  const localSdkPath = path.resolve(options.sdkPath ?? getLocalSdkPackagePath());
  const localSharedPath = getLocalSharedPackagePath(localSdkPath);
  const repoRoot = getRepoRootFromSdkPath(localSdkPath);
  const useWorkspaceSdk = isInsideDir(outputDir, repoRoot);

  fs.mkdirSync(outputDir, { recursive: true });

  const packedSharedTarball = useWorkspaceSdk ? null : packLocalPackage(localSharedPath, outputDir);
  const sdkDependency = useWorkspaceSdk
    ? "workspace:*"
    : `file:${toPosixPath(path.relative(outputDir, packLocalPackage(localSdkPath, outputDir)))}`;

  const packageJson = {
    name: options.pluginName,
    version: "0.1.0",
    type: "module",
    private: true,
    description,
    scripts: {
      build: "node ./esbuild.config.mjs",
      "build:rollup": "rollup -c",
      dev: "node ./esbuild.config.mjs --watch",
      "dev:ui": "paperclip-plugin-dev-server --root . --ui-dir dist/ui --port 4177",
      test: "vitest run --config ./vitest.config.ts",
      typecheck: "tsc --noEmit"
    },
    paperclipPlugin: {
      manifest: "./dist/manifest.js",
      worker: "./dist/worker.js",
      ui: "./dist/ui/"
    },
    keywords: ["paperclip", "plugin", category],
    author,
    license: "MIT",
    ...(packedSharedTarball
      ? {
        pnpm: {
          overrides: {
            "@paperclipai/shared": `file:${toPosixPath(path.relative(outputDir, packedSharedTarball))}`,
          },
        },
      }
      : {}),
    devDependencies: {
      ...(packedSharedTarball
        ? {
          "@paperclipai/shared": `file:${toPosixPath(path.relative(outputDir, packedSharedTarball))}`,
        }
        : {}),
      "@paperclipai/plugin-sdk": sdkDependency,
      "@rollup/plugin-node-resolve": "^16.0.1",
      "@rollup/plugin-typescript": "^12.1.2",
      "@types/node": "^24.6.0",
      "@types/react": "^19.0.8",
      esbuild: "^0.27.3",
      rollup: "^4.38.0",
      tslib: "^2.8.1",
      typescript: "^5.7.3",
      vitest: "^3.0.5"
    },
    peerDependencies: {
      react: ">=18"
    }
  };

  writeFile(path.join(outputDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: "dist",
      rootDir: "."
    },
    include: ["src", "tests"],
    exclude: ["dist", "node_modules"]
  };

  writeFile(path.join(outputDir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);

  writeFile(
    path.join(outputDir, "esbuild.config.mjs"),
    `import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
`,
  );

  writeFile(
    path.join(outputDir, "rollup.config.mjs"),
    `import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

function withPlugins(config) {
  if (!config) return null;
  return {
    ...config,
    plugins: [
      nodeResolve({
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false,
      }),
    ],
  };
}

export default [
  withPlugins(presets.rollup.manifest),
  withPlugins(presets.rollup.worker),
  withPlugins(presets.rollup.ui),
].filter(Boolean);
`,
  );

  writeFile(
    path.join(outputDir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
`,
  );

  writeFile(
    path.join(outputDir, "src", "manifest.ts"),
    `import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: ${quote(manifestId)},
  apiVersion: 1,
  version: "0.1.0",
  displayName: ${quote(displayName)},
  description: ${quote(description)},
  author: ${quote(author)},
  categories: [${quote(category)}],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: ${quote(`${displayName} Health`)},
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
`,
  );

  writeFile(
    path.join(outputDir, "src", "worker.ts"),
    `import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      const issueId = event.entityId ?? "unknown";
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "seen" }, true);
      ctx.logger.info("Observed issue.created", { issueId });
    });

    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    ctx.actions.register("ping", async () => {
      ctx.logger.info("Ping action invoked");
      return { pong: true, at: new Date().toISOString() };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
`,
  );

  writeFile(
    path.join(outputDir, "src", "ui", "index.tsx"),
    `import { usePluginAction, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");
  const ping = usePluginAction("ping");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>${displayName}</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      <button onClick={() => void ping()}>Ping Worker</button>
    </div>
  );
}
`,
  );

  writeFile(
    path.join(outputDir, "tests", "plugin.spec.ts"),
    `import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin scaffold", () => {
  it("registers data + actions and handles events", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
    expect(harness.getState({ scopeKind: "issue", scopeId: "iss_1", stateKey: "seen" })).toBe(true);

    const data = await harness.getData<{ status: string }>("health");
    expect(data.status).toBe("ok");

    const action = await harness.performAction<{ pong: boolean }>("ping");
    expect(action.pong).toBe(true);
  });
});
`,
  );

  writeFile(
    path.join(outputDir, "README.md"),
    `# ${displayName}

${description}

## Development

\`\`\`bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
\`\`\`

${sdkDependency.startsWith("file:")
  ? `This scaffold snapshots \`@paperclipai/plugin-sdk\` and \`@paperclipai/shared\` from a local Paperclip checkout at:\n\n\`${toPosixPath(localSdkPath)}\`\n\nThe packed tarballs live in \`.paperclip-sdk/\` for local development. Before publishing this plugin, switch those dependencies to published package versions once they are available on npm.\n\n`
  : ""}

## Install Into Paperclip

\`\`\`bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \\
  -H "Content-Type: application/json" \\
  -d '{"packageName":"${toPosixPath(outputDir)}","isLocalPath":true}'
\`\`\`

## Build Options

- \`pnpm build\` uses esbuild presets from \`@paperclipai/plugin-sdk/bundlers\`.
- \`pnpm build:rollup\` uses rollup presets from the same SDK.
`,
  );

  writeFile(path.join(outputDir, ".gitignore"), "dist\nnode_modules\n.paperclip-sdk\n");

  return outputDir;
}

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/** CLI wrapper for `scaffoldPluginProject`. */
function runCli() {
  const pluginName = process.argv[2];
  if (!pluginName) {
    // eslint-disable-next-line no-console
    console.error("Usage: create-paperclip-plugin <name> [--template default|connector|workspace] [--output <dir>] [--sdk-path <paperclip-sdk-path>]");
    process.exit(1);
  }

  const template = (parseArg("--template") ?? "default") as PluginTemplate;
  const outputRoot = parseArg("--output") ?? process.cwd();
  const targetDir = path.resolve(outputRoot, packageToDirName(pluginName));

  const out = scaffoldPluginProject({
    pluginName,
    outputDir: targetDir,
    template,
    displayName: parseArg("--display-name"),
    description: parseArg("--description"),
    author: parseArg("--author"),
    category: parseArg("--category") as ScaffoldPluginOptions["category"] | undefined,
    sdkPath: parseArg("--sdk-path"),
  });

  // eslint-disable-next-line no-console
  console.log(`Created plugin scaffold at ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
