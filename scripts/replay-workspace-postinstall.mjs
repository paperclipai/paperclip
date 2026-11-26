#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkspacePackagePaths } from "./ensure-workspace-package-links.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPostinstall(dirPath) {
  const manifestPath = path.join(dirPath, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const script = manifest.scripts?.postinstall;
  return typeof script === "string" && script.trim().length > 0 ? script.trim() : null;
}

export function findWorkspacePostinstallScripts(rootDir = repoRoot) {
  const workspacePaths = discoverWorkspacePackagePaths(rootDir);
  const canonicalRoot = path.resolve(rootDir);
  const workspaceHooks = [];
  const seenDirs = new Set([canonicalRoot]);

  for (const dirPath of Array.from(workspacePaths.values()).sort()) {
    const resolved = path.resolve(dirPath);
    if (seenDirs.has(resolved)) continue;
    seenDirs.add(resolved);
    const script = readPostinstall(resolved);
    if (script) {
      workspaceHooks.push({
        dir: resolved,
        relDir: path.relative(canonicalRoot, resolved).split(path.sep).join("/"),
        script,
      });
    }
  }

  const rootScript = readPostinstall(canonicalRoot);
  return {
    workspaceHooks,
    rootHook: rootScript ? { dir: canonicalRoot, relDir: ".", script: rootScript } : null,
  };
}

function runHook(hook, rootDir, env = process.env) {
  const binDirs = [
    path.join(hook.dir, "node_modules", ".bin"),
    path.join(rootDir, "node_modules", ".bin"),
  ];
  const mergedPath = [...binDirs, env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  return new Promise((resolve, reject) => {
    const child = spawn(hook.script, {
      cwd: hook.dir,
      env: { ...env, PATH: mergedPath },
      shell: true,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      reject(new Error(`postinstall in ${hook.relDir} failed to start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`postinstall in ${hook.relDir} exited with ${signal ?? code}`));
    });
  });
}

export async function replayWorkspacePostinstalls(rootDir = repoRoot, env = process.env) {
  const canonicalRoot = path.resolve(rootDir);
  const { workspaceHooks, rootHook } = findWorkspacePostinstallScripts(canonicalRoot);
  // Mirror `pnpm -r --if-present run postinstall && pnpm run postinstall`:
  // run independent workspace hooks in parallel first, then the root hook.
  await Promise.all(workspaceHooks.map((hook) => runHook(hook, canonicalRoot, env)));
  if (rootHook) {
    await runHook(rootHook, canonicalRoot, env);
  }
  return {
    workspaceCount: workspaceHooks.length,
    ranRoot: Boolean(rootHook),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await replayWorkspacePostinstalls();
}
