import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDevRunnerWorktreeEnv,
  applyEmptyWorktreeSigningSecrets,
  isWorktreeSeedPending,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
} from "../dev-runner-worktree.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe("dev-runner worktree env bootstrap", () => {
  it("prepares clean workspace contracts before managed UI and migration imports", async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const tsx = import.meta.resolve("tsx");
    const root = createTempRoot("paperclip-dev-runner-cold-build-");
    const copy = (relative: string) => {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(repoRoot, relative), target, { recursive: true,
        filter: source => !["dist", "node_modules", "migrations"].includes(path.basename(source)) });
    };
    for (const relative of ["package.json", "tsconfig.json", "tsconfig.base.json", "scripts/dev-runner.ts",
      "scripts/dev-runner-output.ts", "scripts/dev-runner-options.ts", "scripts/dev-runner-snapshot.mjs",
      "scripts/dev-runner-paths.mjs", "scripts/dev-runner-native-binary.mjs", "scripts/dev-service-profile.ts",
      "scripts/ensure-plugin-build-deps.mjs", "packages/paperclip-runner/src/live/runner-binary.ts",
      ...["packages/runner-sdk", "packages/shared", "packages/plugins/sdk", "packages/db"].flatMap(directory =>
        ["src", "package.json", "tsconfig.json"].map(name => `${directory}/${name}`))]) copy(relative);
    const sharedManifestPath = path.join(root, "packages/shared/package.json");
    const sharedManifest = JSON.parse(fs.readFileSync(sharedManifestPath, "utf8"));
    sharedManifest.dependencies = { ...sharedManifest.dependencies, "@paperclipai/runner-sdk": "workspace:*" };
    fs.writeFileSync(sharedManifestPath, JSON.stringify(sharedManifest));
    fs.appendFileSync(path.join(root, "packages/shared/src/index.ts"),
      '\nexport { HARNESS_PROTOCOL_SCHEMA as coldBootstrapHarnessProtocolSchema } from "@paperclipai/runner-sdk/contracts";\n');
    fs.symlinkSync(path.join(repoRoot, "server"), path.join(root, "server"), "junction");
    const packages = [["runner-sdk", "packages/runner-sdk"], ["shared", "packages/shared"],
      ["plugin-sdk", "packages/plugins/sdk"], ["db", "packages/db"]];
    for (const directory of ["", ...packages.map(([, directory]) => directory)]) {
      const modules = path.join(root, directory, "node_modules");
      fs.mkdirSync(path.join(modules, "@paperclipai"), { recursive: true });
      for (const entry of fs.readdirSync(path.join(repoRoot, directory, "node_modules"))) {
        if (entry === "@paperclipai") continue;
        const source = path.join(repoRoot, directory, "node_modules", entry);
        fs.symlinkSync(source, path.join(modules, entry), fs.statSync(source).isDirectory() ? "junction" : "file");
      }
      for (const [name, target] of packages) {
        fs.symlinkSync(path.join(root, target), path.join(modules, "@paperclipai", name), "junction");
      }
    }
    fs.writeFileSync(path.join(root, "packages/db/src/migration-runtime.ts"),
      "export async function resolveMigrationConnection(){throw new Error('MIGRATION_IMPORT_READY_NO_DATABASE')}\n");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const pnpm = path.join(bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    const dispatch = path.join(bin, "dispatch.cjs");
    fs.writeFileSync(dispatch, `const { spawnSync } = require("node:child_process");
const fs = require("node:fs"); const path = require("node:path");
const root = ${JSON.stringify(root)}; const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "commands"), JSON.stringify(args) + "\\n");
let command;
if (args.includes("ensure-build-deps")) command = [path.join(root, "scripts/ensure-plugin-build-deps.mjs")];
else if (args.includes("src/migration-status.ts")) command = ["--import", ${JSON.stringify(tsx)}, path.join(root, "packages/db/src/migration-status.ts"), "--json"];
else if (args.includes("@paperclipai/ui") && args.includes("build")) command = ["--import", ${JSON.stringify(tsx)}, "--input-type=module", "--eval",
  "const shared = await import(" + JSON.stringify(${JSON.stringify(pathToFileURL(path.join(root, "packages/shared/src/index.ts")).href)})
    + "); if(shared.coldBootstrapHarnessProtocolSchema !== 'paperclip.harness.v1') throw new Error('SDK contract missing'); console.log('UI_IMPORT_READY');"];
else { console.error("Unexpected app/build command: " + JSON.stringify(args)); process.exit(91); }
const child = spawnSync(process.execPath, command, { cwd: root, env: process.env, stdio: "inherit" });
if (child.error) throw child.error; process.exit(child.status ?? 1);\n`);
    fs.writeFileSync(pnpm, process.platform === "win32" ? `@"${process.execPath}" "${dispatch}" %*\r\n`
      : `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(dispatch).href)});\n`, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      PAPERCLIP_HOME: path.join(root, "home"), PAPERCLIP_CONFIG: path.join(root, "unused-config.json"),
      PAPERCLIP_INSTANCE_ID: "cold-build-test", PAPERCLIP_MANAGED_RUNTIME_EXPOSURE: "tailscale_https" };
    delete env.DATABASE_URL;
    delete env.PAPERCLIP_UI_DEV_MIDDLEWARE;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsx, path.join(root, "scripts/dev-runner.ts"), "dev"], {
        cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      const timeout = setTimeout(() => {
        if (!child.pid) return;
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        else { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); } }
      }, 45_000);
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", code => { clearTimeout(timeout); resolve({ code, output }); });
    });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("MIGRATION_IMPORT_READY_NO_DATABASE");
    expect(result.output).toContain("UI_IMPORT_READY");
    expect(result.output).not.toMatch(/ERR_MODULE_NOT_FOUND|Unexpected app\/build command/);
    const commands = fs.readFileSync(path.join(root, "commands"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(commands[0]).toEqual(["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"]);
    expect(commands).toHaveLength(3);
    expect(fs.existsSync(path.join(root, "packages/runner-sdk/dist/index.js"))).toBe(true);
  }, 60_000);

  it("uses saved empty-instance signing keys instead of inherited source keys", () => {
    const root = createTempRoot("paperclip-empty-signing-keys-");
    fs.mkdirSync(path.join(root, ".paperclip"));
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/empty\n");
    fs.writeFileSync(path.join(root, ".paperclip", "seed-empty"), "explicitly empty\n");
    fs.writeFileSync(resolveWorktreeEnvFilePath(root), 'PAPERCLIP_AGENT_JWT_SECRET="fresh-jwt"\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET="fresh-actions"\n');
    const env = { PAPERCLIP_AGENT_JWT_SECRET: "source-jwt", PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "source-actions", BETTER_AUTH_SECRET: "source-auth" };
    bootstrapDevRunnerWorktreeEnv(root, env);
    expect(env).toMatchObject({ PAPERCLIP_AGENT_JWT_SECRET: "fresh-jwt", PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "fresh-actions", BETTER_AUTH_SECRET: "fresh-jwt" });
    fs.writeFileSync(resolveWorktreeEnvFilePath(root), 'PAPERCLIP_AGENT_JWT_SECRET="fresh-jwt"\n');
    expect(() => applyEmptyWorktreeSigningSecrets(root, env)).toThrow("missing its saved PAPERCLIP_TOOL_ACTION_SIGNING_SECRET");
  });
  it("guards seed-pending worktrees until a seed-complete marker exists", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-pending-");
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".paperclip", "seed-pending"), "{}\n", "utf8");

    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(path.join(root, ".paperclip", "seed-complete"), "{}\n", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);
  });

  it("guards every manifest state except a complete verified manifest", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-manifest-");
    const manifestPath = path.join(root, ".paperclip", "seed-manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "failed" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "verified" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 2,
      source: { instanceId: "source", configPath: "/source/config.json" },
      snapshotAt: "2026-08-18T00:00:00.000Z",
      seedMode: "minimal",
      migrationRevision: "0001",
      targetInstanceId: "target",
      phase: "complete",
      state: "verified",
      attemptId: "attempt",
      startedAt: "2026-08-18T00:00:00.000Z",
      finishedAt: "2026-08-18T00:01:00.000Z",
      diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
    }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);

    fs.writeFileSync(manifestPath, "not-json", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);
  });

  it("detects linked git worktrees from .git files", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(isLinkedGitWorktreeCheckout(root)).toBe(true);
  });

  it("loads repo-local Paperclip env for initialized worktrees without overriding explicit env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-env-");
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "PAPERCLIP_HOME=/tmp/paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=feature-worktree",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=feature-worktree",
        "PAPERCLIP_OPTIONAL= # comment-only value",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_INSTANCE_ID: "already-set",
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBe("/tmp/paperclip-worktrees");
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("already-set");
    expect(env.PAPERCLIP_IN_WORKTREE).toBe("true");
    expect(env.PAPERCLIP_OPTIONAL).toBe("");
  });

  it("repairs stale migrated config paths before loading worktree env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-migrated-env-");
    const localConfigPath = path.join(root, ".paperclip", "config.json");
    const worktreesDir = path.join(root, ".paperclip-worktrees");
    fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(localConfigPath, "{}\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "PAPERCLIP_HOME=/old/home/.paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=feature-worktree",
        "PAPERCLIP_CONFIG=/old/home/paperclip/.paperclip/worktrees/feature/.paperclip/config.json",
        "PAPERCLIP_CONTEXT=/old/home/.paperclip-worktrees/context.json",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=feature-worktree",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_WORKTREES_DIR: worktreesDir,
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBe(worktreesDir);
    expect(env.PAPERCLIP_CONFIG).toBe(localConfigPath);
    expect(env.PAPERCLIP_CONTEXT).toBe(path.join(worktreesDir, "context.json"));
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("feature-worktree");
  });

  it("reports uninitialized linked worktrees so dev runner can fail fast", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-missing-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(bootstrapDevRunnerWorktreeEnv(root, {})).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: true,
    });
  });
});
