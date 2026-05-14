#!/usr/bin/env node
// Cross-platform installer for the Paperclip Document-Opener helper.
// macOS: writes a launchd .plist and bootstraps it.
// Windows: writes a Task Scheduler .xml and registers it via schtasks.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const DIST_SCRIPT = join(SCRIPT_DIR, "dist", "main.js");
const CONFIG_DIR = join(homedir(), ".paperclip");
const CONFIG_PATH = join(CONFIG_DIR, "document-opener.json");
const NODE_BIN = process.execPath;

function log(msg) { console.log(`[install] ${msg}`); }
function die(msg) { console.error(`[install] ${msg}`); process.exit(1); }

function ensureDefaultConfig() {
  if (existsSync(CONFIG_PATH)) {
    log(`config exists at ${CONFIG_PATH} — leaving untouched`);
    return;
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  const defaultConfig = {
    port: 19327,
    roots: [
      join(homedir(), "Documents"),
    ],
    allowedOrigins: [
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "https://company.whitestag.ai",
    ],
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + "\n");
  log(`wrote default config to ${CONFIG_PATH} — edit "roots" to suit your setup`);
}

function build() {
  log("building dist/main.js …");
  const result = spawnSync("pnpm", ["--filter", "@paperclipai/document-opener", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) die("build failed");
  if (!existsSync(DIST_SCRIPT)) die(`build produced no ${DIST_SCRIPT}`);
}

function substitute(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

async function healthCheck(port) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200 || res.status === 503) {
        log(`health-check OK (status ${res.status}) at ${url}`);
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  die(`health-check timeout: ${url} did not respond within 10s`);
}

function installMacOs() {
  const PLIST_LABEL = "ing.paperclip.document-opener";
  const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
  const PLIST_PATH = join(PLIST_DIR, `${PLIST_LABEL}.plist`);
  const LOGS_DIR = join(homedir(), "Library", "Logs", "paperclip-document-opener");
  const TEMPLATE = readFileSync(join(SCRIPT_DIR, "templates", `${PLIST_LABEL}.plist.template`), "utf8");

  mkdirSync(PLIST_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const filled = substitute(TEMPLATE, {
    NODE_BIN,
    SCRIPT: DIST_SCRIPT,
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LOGS: LOGS_DIR,
  });

  writeFileSync(PLIST_PATH, filled);
  log(`wrote plist to ${PLIST_PATH}`);

  const uid = userInfo().uid;
  log(`bootstrapping launchd as gui/${uid} …`);
  // Best-effort unload first (idempotent re-run)
  spawnSync("launchctl", ["bootout", `gui/${uid}`, PLIST_PATH], { stdio: "ignore" });
  const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH], { stdio: "inherit" });
  if (result.status !== 0) die("launchctl bootstrap failed");
}

function installWindows() {
  const TASK_NAME = "\\Paperclip\\DocumentOpener";
  const LOGS_DIR = join(process.env.LOCALAPPDATA || homedir(), "Paperclip", "document-opener", "logs");
  const TASK_XML_PATH = join(tmpdir(), "paperclip-document-opener-task.xml");
  const TEMPLATE = readFileSync(join(SCRIPT_DIR, "templates", "document-opener-task.xml.template"), "utf8");

  mkdirSync(LOGS_DIR, { recursive: true });

  const user = `${process.env.USERDOMAIN || ""}\\${userInfo().username}`.replace(/^\\/, "");
  const filled = substitute(TEMPLATE, {
    NODE_BIN,
    SCRIPT: DIST_SCRIPT,
    WORKDIR: SCRIPT_DIR,
    USER: user,
  });

  // schtasks expects UTF-16 LE for /xml input
  const utf16 = Buffer.from("﻿" + filled, "utf16le");
  writeFileSync(TASK_XML_PATH, utf16);
  log(`wrote task xml to ${TASK_XML_PATH}`);

  log(`registering task ${TASK_NAME} …`);
  const createResult = spawnSync("schtasks", ["/create", "/xml", TASK_XML_PATH, "/tn", TASK_NAME, "/f"], { stdio: "inherit" });
  if (createResult.status !== 0) die("schtasks /create failed");

  log("starting task …");
  const runResult = spawnSync("schtasks", ["/run", "/tn", TASK_NAME], { stdio: "inherit" });
  if (runResult.status !== 0) die("schtasks /run failed");
}

async function main() {
  log(`platform: ${platform()}`);
  log(`node:     ${NODE_BIN}`);

  ensureDefaultConfig();
  build();

  switch (platform()) {
    case "darwin": installMacOs(); break;
    case "win32":  installWindows(); break;
    default: die(`unsupported platform: ${platform()}`);
  }

  // Read port from config to know where to health-check
  let port = 19327;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof cfg.port === "number") port = cfg.port;
  } catch {}

  await healthCheck(port);
  log("install complete.");
}

main().catch((err) => die(err.message));
