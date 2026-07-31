#!/usr/bin/env node
// prepare-server-ui-dist.mjs — Build the UI and copy it into server/ui-dist.
// This keeps @paperclipai/server publish artifacts self-contained for static UI
// serving. When PAPERCLIP_RELEASE_REUSE_UI_DIST=1 and ui/dist already exists,
// reuse that output instead of rebuilding it inside the release packaging flow.
//
// Node port of the former prepare-server-ui-dist.sh so the prepack/release flow
// runs on Windows without a POSIX shell.

import { existsSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIST = path.join(REPO_ROOT, "ui", "dist");
const SERVER_UI_DIST = path.join(REPO_ROOT, "server", "ui-dist");

const reuseFlag = (process.env.PAPERCLIP_RELEASE_REUSE_UI_DIST ?? "").toLowerCase();
const shouldReuseExistingUiDist = ["1", "true", "yes"].includes(reuseFlag);

if (shouldReuseExistingUiDist && existsSync(path.join(UI_DIST, "index.html"))) {
  console.log("  -> Reusing existing @paperclipai/ui dist output");
} else {
  console.log("  -> Building @paperclipai/ui...");
  execFileSync("pnpm", ["--filter", "@paperclipai/ui", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

if (!existsSync(path.join(UI_DIST, "index.html"))) {
  console.error(`Error: UI build output missing at ${path.join(UI_DIST, "index.html")}`);
  process.exit(1);
}

rmSync(SERVER_UI_DIST, { recursive: true, force: true });
cpSync(UI_DIST, SERVER_UI_DIST, { recursive: true });
console.log("  -> Copied ui/dist to server/ui-dist");
