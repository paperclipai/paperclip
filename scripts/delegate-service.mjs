#!/usr/bin/env node
// Helpers for running delegate mode as a platform background service.
// The supervisor integration reuses `paperclipai service` (systemd user unit
// on Linux, launchd agent on macOS). Delegate mode runs from a source
// checkout, so the service definition points at scripts/delegate-service-shim.sh
// via PAPERCLIP_SHIM_PATH instead of the managed ~/.local/bin/paperclipai shim.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DELEGATE_NO_SERVICE_ENV = "PAPERCLIP_DELEGATE_NO_SERVICE";
export const DELEGATE_FORCE_FOREGROUND_ENV = "PAPERCLIP_DELEGATE_FORCE_FOREGROUND";

function repoRootFromHere() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveDelegateShimPath(repoRoot = repoRootFromHere()) {
  return join(resolve(repoRoot), "scripts", "delegate-service-shim.sh");
}

export function resolveDelegateCliArgs({ tsxPath, cliEntry }) {
  return [tsxPath, cliEntry];
}

export function isNoServiceRequested(env = process.env) {
  const raw = env[DELEGATE_NO_SERVICE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isForceForeground(env = process.env) {
  const raw = env[DELEGATE_FORCE_FOREGROUND_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isServiceActiveStatus(status) {
  if (!status || typeof status !== "object") return false;
  return status.installed === true && status.active === true;
}

export function shouldStartTempServer({ healthOk, serviceActive }) {
  // Start a foreground temp server for provisioning only when nothing is
  // already serving. An active service always wins over a temp process.
  if (serviceActive) return false;
  return !healthOk;
}

export function shouldWaitOnTempServer({ serviceActive, tempServerStarted, exitAfterSetup }) {
  if (exitAfterSetup) return false;
  if (serviceActive) return false;
  return tempServerStarted;
}

function main() {
  const command = process.argv[2];
  if (command === "shim-path") {
    process.stdout.write(`${resolveDelegateShimPath()}\n`);
    return;
  }
  throw new Error("Usage: delegate-service.mjs <shim-path>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
