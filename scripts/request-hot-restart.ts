#!/usr/bin/env -S node --import tsx
import { writeHotRestartIntent } from "../server/src/hot-restart-intent.js";

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const serverPidRaw = readArg("--server-pid");
const serverPid = Number(serverPidRaw);
if (!Number.isInteger(serverPid) || serverPid <= 0) {
  console.error("Usage: scripts/request-hot-restart.ts --server-pid <pid> [--drain-required]");
  process.exit(2);
}

const intent = writeHotRestartIntent(new Date(), serverPid, {
  requestedByRunId: process.env.PAPERCLIP_RUN_ID ?? null,
  drainRequired: process.argv.includes("--drain-required"),
});
process.stdout.write(`${JSON.stringify(intent)}\n`);
