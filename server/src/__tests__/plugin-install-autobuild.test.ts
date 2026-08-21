import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import {
  ensureLocalPluginBuilt,
  pluginLoader,
  REPO_ROOT,
} from "../services/plugin-loader.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin install auto-build tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type FixturePlugin = {
  packageName: string;
  pluginKey: string;
  packageRoot: string;
  distDir: string;
};

const repoPluginRoot = path.join(REPO_ROOT, "packages", "plugins");
const standaloneRepoPluginRoot = path.join(repoPluginRoot, "sandbox-providers");

async function createBundledPluginFixture(
  nameSuffix: string,
  options: { rootDir?: string; buildDistImmediately?: boolean } = {},
): Promise<FixturePlugin> {
  const slug = `plugin-autobuild-${nameSuffix}-${randomUUID().slice(0, 8)}`;
  const packageName = `@paperclipai/${slug}`;
  const pluginKey = `paperclip.${slug.replace(/^plugin-/, "").replace(/-/g, "_")}`;
  const packageRoot = path.join(options.rootDir ?? repoPluginRoot, slug);
  const distDir = path.join(packageRoot, "dist");
  const isStandaloneFixture = (options.rootDir ?? repoPluginRoot) === standaloneRepoPluginRoot;
  const postinstallScript = isStandaloneFixture
    ? `node ${path.relative(packageRoot, path.join(REPO_ROOT, "scripts", "link-plugin-dev-sdk.mjs"))}`
    : null;

  await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        ...(postinstallScript ? { postinstall: postinstallScript } : {}),
        build: "node ./scripts/build.mjs",
      },
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
        worker: "./dist/worker.js",
        ui: "./dist/ui/",
      },
    }, null, 2),
    "utf8",
  );

  const manifest = {
    id: pluginKey,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Autobuild Fixture",
    description: "Bundled plugin fixture for install-time auto-build coverage.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["companies.read"],
    entrypoints: {
      worker: "./dist/worker.js",
    },
  };

  await writeFile(
    path.join(packageRoot, "scripts", "build.mjs"),
    [
      "import { mkdir, writeFile } from \"node:fs/promises\";",
      "import path from \"node:path\";",
      "import { fileURLToPath } from \"node:url\";",
      "",
      "const scriptDir = path.dirname(fileURLToPath(import.meta.url));",
      "const packageRoot = path.resolve(scriptDir, \"..\");",
      "const distDir = path.join(packageRoot, \"dist\");",
      "const uiDir = path.join(distDir, \"ui\");",
      `const manifest = ${JSON.stringify(manifest, null, 2)};`,
      "",
      "await mkdir(uiDir, { recursive: true });",
      "await writeFile(path.join(distDir, \"manifest.js\"), `export default ${JSON.stringify(manifest, null, 2)};\\n`, \"utf8\");",
      "await writeFile(path.join(distDir, \"worker.js\"), \"export {};\\n\", \"utf8\");",
      "await writeFile(path.join(uiDir, \"index.js\"), \"export default {};\\n\", \"utf8\");",
    ].join("\n"),
    "utf8",
  );

  if (options.buildDistImmediately) {
    await mkdir(path.join(distDir, "ui"), { recursive: true });
    await writeFile(path.join(distDir, "manifest.js"), `export default ${JSON.stringify(manifest, null, 2)};\n`, "utf8");
    await writeFile(path.join(distDir, "worker.js"), "export {};\n", "utf8");
    await writeFile(path.join(distDir, "ui", "index.js"), "export default {};\n", "utf8");
  }

  return { packageName, pluginKey, packageRoot, distDir };
}

async function createInstallApp(db: ReturnType<typeof createDb>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const loader = pluginLoader(db, {
    enableLocalFilesystem: false,
    enableNpmDiscovery: false,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(db as never, loader as never, {} as never, undefined, {} as never, {} as never));
  app.use(errorHandler);
  return app;
}

describe("ensureLocalPluginBuilt", () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  it("skips auto-build for local plugin paths outside the repo", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-outside-"));
    const packageRoot = path.join(tempRoot, "plugin-outside");
    cleanupPaths.add(path.dirname(packageRoot));
    await mkdir(packageRoot, { recursive: true });

    const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await ensureLocalPluginBuilt(
      packageRoot,
      {
        name: "@paperclipai/plugin-outside",
        paperclipPlugin: {
          manifest: "./dist/manifest.js",
          worker: "./dist/worker.js",
        },
      },
      { execFileAsyncImpl: execStub },
    );

    expect(execStub).not.toHaveBeenCalled();
  });

  it("skips auto-build when PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD=1", async () => {
    const fixture = await createBundledPluginFixture("skip");
    cleanupPaths.add(fixture.packageRoot);

    const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      {
        processEnv: { PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD: "1" },
        execFileAsyncImpl: execStub,
      },
    );

    expect(execStub).not.toHaveBeenCalled();
  });

  it("bootstraps standalone bundled plugins before building them", async () => {
    const fixture = await createBundledPluginFixture("standalone", { rootDir: standaloneRepoPluginRoot });
    cleanupPaths.add(fixture.packageRoot);

    const execStub = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.join(" ") === "install --ignore-workspace --no-lockfile") {
        await mkdir(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"), { recursive: true });
      }
      if (args.join(" ") === "build") {
        await mkdir(path.join(fixture.distDir, "ui"), { recursive: true });
        await writeFile(path.join(fixture.distDir, "manifest.js"), "export default {};\n", "utf8");
        await writeFile(path.join(fixture.distDir, "worker.js"), "export {};\n", "utf8");
        await writeFile(path.join(fixture.distDir, "ui", "index.js"), "export default {};\n", "utf8");
      }
      return { stdout: "", stderr: "" };
    });
    await ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      { execFileAsyncImpl: execStub },
    );

    expect(execStub).toHaveBeenCalledTimes(2);
    expect(execStub).toHaveBeenNthCalledWith(
      1,
      "pnpm",
      ["install", "--ignore-workspace", "--no-lockfile"],
      { cwd: fixture.packageRoot, timeout: 120_000 },
    );
    expect(execStub).toHaveBeenNthCalledWith(
      2,
      "pnpm",
      ["build"],
      { cwd: fixture.packageRoot, timeout: 120_000 },
    );
  });

  it("bootstraps standalone bundled plugin runtime dependencies when dist already exists", async () => {
    const fixture = await createBundledPluginFixture("standalone-runtime", {
      rootDir: standaloneRepoPluginRoot,
      buildDistImmediately: true,
    });
    cleanupPaths.add(fixture.packageRoot);

    const execStub = vi.fn(async () => {
      await mkdir(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"), { recursive: true });
      return { stdout: "", stderr: "" };
    });
    await ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      { execFileAsyncImpl: execStub },
    );

    expect(execStub).toHaveBeenCalledTimes(1);
    expect(execStub).toHaveBeenNthCalledWith(
      1,
      "pnpm",
      ["install", "--ignore-workspace", "--no-lockfile"],
      { cwd: fixture.packageRoot, timeout: 120_000 },
    );
  });
});

describeEmbeddedPostgres("plugin install auto-build route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-autobuild-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(plugins);
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
    delete process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  it("auto-builds bundled local plugins during POST /api/plugins/install when dist is missing", async () => {
    const fixture = await createBundledPluginFixture("success");
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(200);
    expect(res.body.packageName).toBe(fixture.packageName);
    expect(res.body.pluginKey).toBe(fixture.pluginKey);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "worker.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "ui", "index.js"))).toBe(true);
    expect(mockLifecycle.load).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("auto-builds standalone bundled local plugins outside the root pnpm workspace", async () => {
    const fixture = await createBundledPluginFixture("standalone-success", { rootDir: standaloneRepoPluginRoot });
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules"))).toBe(false);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(200);
    expect(res.body.packageName).toBe(fixture.packageName);
    expect(res.body.pluginKey).toBe(fixture.pluginKey);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "worker.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "ui", "index.js"))).toBe(true);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"))).toBe(true);
    expect(mockLifecycle.load).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("bootstraps standalone bundled local plugin runtime dependencies when dist already exists", async () => {
    const fixture = await createBundledPluginFixture("standalone-runtime-success", {
      rootDir: standaloneRepoPluginRoot,
      buildDistImmediately: true,
    });
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(true);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"))).toBe(false);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(200);
    expect(res.body.packageName).toBe(fixture.packageName);
    expect(res.body.pluginKey).toBe(fixture.pluginKey);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"))).toBe(true);
    expect(mockLifecycle.load).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("returns the manual build command when auto-build is disabled and dist is missing", async () => {
    process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"] = "1";
    const fixture = await createBundledPluginFixture("disabled");
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("does not appear to be a Paperclip plugin (no manifest found)");
    expect(res.body.error).toContain(`pnpm --filter ${fixture.packageName} build`);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
    expect(mockLifecycle.load).not.toHaveBeenCalled();
  }, 20_000);

  it("returns the standalone bootstrap command when auto-build is disabled for sandbox-provider plugins", async () => {
    process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"] = "1";
    const fixture = await createBundledPluginFixture("standalone-disabled", { rootDir: standaloneRepoPluginRoot });
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("does not appear to be a Paperclip plugin (no manifest found)");
    expect(res.body.error).toContain(path.relative(REPO_ROOT, fixture.packageRoot));
    expect(res.body.error).toContain("pnpm install --ignore-workspace --no-lockfile && pnpm build");
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
    expect(mockLifecycle.load).not.toHaveBeenCalled();
  }, 20_000);
});
