#!/usr/bin/env node
// Sibling pm2 process: asset-library-watcher
// Watches source dirs, debounces 5s, rebuilds + restarts asset-library.
import { watch } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname);

const WATCH_DIRS = ["app", "lib", "components", "pages"];
const DEBOUNCE_MS = 5000;

const NODE_PATH = `/opt/homebrew/opt/node@20/bin:${process.env.PATH ?? ""}`;

function log(msg) {
  process.stdout.write(`[asset-library-watcher] ${new Date().toISOString()} ${msg}\n`);
}

let debounceTimer = null;
let building = false;

function triggerBuild(changedPath) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (building) {
      log("build in progress — skipping");
      return;
    }
    building = true;
    log(`change: ${changedPath} — npm run build`);
    try {
      execSync("npm run build", {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "production", PATH: NODE_PATH },
      });
      log("build done — pm2 restart asset-library");
      execSync("pm2 restart asset-library", { stdio: "inherit" });
      log("restarted");
    } catch (err) {
      log(`ERROR: ${err.message}`);
    } finally {
      building = false;
    }
  }, DEBOUNCE_MS);
}

let watching = 0;
for (const dir of WATCH_DIRS) {
  const abs = resolve(ROOT, dir);
  try {
    watch(abs, { recursive: true }, (_event, filename) => {
      triggerBuild(`${abs}/${filename ?? "?"}`);
    });
    log(`watching ${abs}`);
    watching++;
  } catch (err) {
    if (err.code === "ENOENT") {
      log(`skip ${abs} — not found`);
    } else {
      throw err;
    }
  }
}

if (watching === 0) {
  log("ERROR: no directories found to watch — exiting");
  process.exit(1);
}

log("watcher ready");
