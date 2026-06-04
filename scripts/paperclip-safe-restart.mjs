#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY;
const emergencyReason = process.env.PAPERCLIP_RESTART_EMERGENCY_REASON?.trim();
const emergencyCategory = process.env.PAPERCLIP_RESTART_EMERGENCY_CATEGORY?.trim() || "operator_override";

const args = process.argv.slice(2);
let endpoint = "/api/health/service-restart/check";
let commandStart = -1;
let emergency = Boolean(emergencyReason);
let checkOnly = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") {
    commandStart = index + 1;
    break;
  }
  if (arg === "--dev-server") {
    endpoint = "/api/health/dev-server/restart";
    continue;
  }
  if (arg === "--emergency") {
    emergency = true;
    continue;
  }
  if (arg === "--check-only") {
    checkOnly = true;
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    console.log([
      "Usage: paperclip-safe-restart.mjs [--emergency] [--check-only] [--dev-server] [-- <command> ...]",
      "",
      "Default mode checks the service restart drain guard at /api/health/service-restart/check.",
      "Use --dev-server only for the local dev-runner restart request path.",
      "Emergency mode requires PAPERCLIP_RESTART_EMERGENCY_REASON but sends only reason-present/category metadata.",
    ].join("\n"));
    process.exit(0);
  }
  console.error(JSON.stringify({
    status: "failed",
    error: "unknown_argument",
    argument: arg,
  }));
  process.exit(64);
}

const restartCommand = commandStart >= 0 ? args.slice(commandStart) : [];

function headers(extra = {}) {
  const out = { Accept: "application/json", ...extra };
  if (apiKey) out.Authorization = `Bearer ${apiKey}`;
  return out;
}

async function readJson(response) {
  return await response.json().catch(() => ({}));
}

if (emergency && !emergencyReason) {
  console.error("Emergency restart requires PAPERCLIP_RESTART_EMERGENCY_REASON.");
  process.exit(64);
}

const response = await fetch(`${apiBase}${endpoint}`, {
  method: "POST",
  headers: headers({ "Content-Type": "application/json" }),
  body: JSON.stringify(
    emergency
      ? {
        emergency: true,
        emergencyReasonProvided: true,
        emergencyReasonCategory: emergencyCategory,
      }
      : {},
  ),
});
const payload = await readJson(response);

if (!response.ok) {
  console.error(JSON.stringify({
    status: "failed",
    httpStatus: response.status,
    error: payload.error ?? "restart_request_failed",
  }));
  process.exit(1);
}

if (payload.status === "restart_deferred") {
  console.log(JSON.stringify({
    status: "deferred",
    activeRunCount: payload.activeRunCount ?? null,
    oldestRunStartedAt: payload.oldestRunStartedAt ?? null,
    oldestRunAgeMs: payload.oldestRunAgeMs ?? null,
    nextCheckAt: payload.nextCheckAt ?? null,
  }));
  process.exit(75);
}

console.log(JSON.stringify({
  status: payload.status ?? "restart_requested",
  activeRunCount: payload.activeRunCount ?? null,
  oldestRunStartedAt: payload.oldestRunStartedAt ?? null,
  oldestRunAgeMs: payload.oldestRunAgeMs ?? null,
}));

if (checkOnly || restartCommand.length === 0) {
  process.exit(0);
}

const result = spawnSync(restartCommand[0], restartCommand.slice(1), {
  stdio: "inherit",
});

if (result.signal) {
  console.error(JSON.stringify({
    status: "failed",
    error: "restart_command_signaled",
    signal: result.signal,
  }));
  process.exit(1);
}

process.exit(result.status ?? 0);
