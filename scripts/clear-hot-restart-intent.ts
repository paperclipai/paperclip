#!/usr/bin/env -S node --import tsx
import {
  readHotRestartIntent,
  removeHotRestartIntent,
} from "../server/src/services/hot-restart.js";

function usage(): never {
  console.error("Usage: clear-hot-restart-intent.ts --server-pid <pid>");
  process.exit(2);
}

const flag = process.argv[2];
const serverPid = Number(process.argv[3]);
if (flag !== "--server-pid" || !Number.isInteger(serverPid) || serverPid <= 0) usage();

const intent = await readHotRestartIntent();
if (!intent || intent.previousServerPid !== serverPid) {
  console.log(JSON.stringify({ status: "not_matching", serverPid }));
  process.exit(0);
}

await removeHotRestartIntent(undefined, intent);
console.log(JSON.stringify({ status: "removed_matching_intent", serverPid }));
