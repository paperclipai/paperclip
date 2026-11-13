// Local operator companion. Never print or send the control credential remotely.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [file, action, requestId] = process.argv.slice(2);
assert(file && ["status", "approve", "queue", "stop"].includes(action),
  "Usage: node server/scripts/dot-runner-live-control.mjs <control.json> status|approve <requestId>|queue|stop");
const config = JSON.parse(await readFile(file, "utf8"));
const origin = new URL(config.controlOrigin);
assert(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.pathname === "/" && !origin.username && !origin.password);
assert(typeof config.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(config.token));
if (action === "approve") assert(requestId, "Inspect status and supply the exact pending request ID to approve");
const response = await fetch(new URL(`/${action}`, origin), {
  method: action === "status" ? "GET" : "POST",
  headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
  ...(action === "approve" ? { body: JSON.stringify({ requestId }) } : {}),
  redirect: "error", signal: AbortSignal.timeout(30_000),
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
