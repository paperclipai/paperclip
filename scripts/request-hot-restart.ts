#!/usr/bin/env -S node --import tsx
import {
  resolveHotRestartIntentPath,
  writeHotRestartIntent,
} from "../server/src/services/hot-restart.js";

function usage(): never {
  console.error([
    "Usage: tsx scripts/request-hot-restart.ts --server-pid <pid> [--drain-required]",
    "",
    "Writes a one-shot hot-restart intent marker under PAPERCLIP_HOME.",
  ].join("\n"));
  process.exit(2);
}

function readArgs(argv: string[]) {
  let serverPid: number | null = null;
  let drainRequired = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server-pid") {
      const raw = argv[index + 1];
      if (!raw) usage();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) usage();
      serverPid = parsed;
      index += 1;
      continue;
    }
    if (arg === "--drain-required") {
      drainRequired = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if (!serverPid) usage();
  return { serverPid, drainRequired };
}

function normalizeApiBase(raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/api$/, "");
}

async function readPreviousServerVersion() {
  const apiBase = normalizeApiBase(process.env.PAPERCLIP_API_URL);
  if (!apiBase) return null;
  try {
    const response = await fetch(`${apiBase}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown>;
    return typeof body.serverVersion === "string"
      ? body.serverVersion
      : typeof body.version === "string"
        ? body.version
        : null;
  } catch {
    return null;
  }
}

const { serverPid, drainRequired } = readArgs(process.argv.slice(2));
const intent = await writeHotRestartIntent({
  previousServerPid: serverPid,
  previousServerVersion: await readPreviousServerVersion(),
  drainRequired,
  requestedByRunId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
});

console.log(JSON.stringify({
  status: "hot_restart_intent_written",
  intentPath: resolveHotRestartIntentPath(),
  previousServerPid: intent.previousServerPid,
  previousServerVersion: intent.previousServerVersion,
  drainRequired: intent.drainRequired,
}, null, 2));
