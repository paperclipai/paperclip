#!/usr/bin/env node
/**
 * Read-only preflight ("doctor") for the Paperclip Tailscale HTTPS broker.
 *
 * Verifies every host prerequisite for automatic branch-runtime HTTPS WITHOUT
 * mutating any Tailscale or host state. Safe to run at any time, including on a
 * production node. It never calls `serve`, `funnel`, `cert`, `reset`, or any
 * write operation — only `tailscale version`, `status --json`, and
 * `serve status --json`.
 *
 * Exit code 0 = all required checks passed; 1 = one or more failed.
 *
 * Env:
 *   PAPERCLIP_TS_BROKER_TAILSCALE  absolute tailscale binary (default /usr/bin/tailscale, falls back to PATH)
 *   PAPERCLIP_TS_BROKER_SOCKET     broker socket path to inspect (optional)
 *   PAPERCLIP_TS_BROKER_PORT_MIN / _MAX   dedicated exposure range (default 39000-49999)
 *   PAPERCLIP_PRIMARY_TARGET       expected primary target (default http://127.0.0.1:3100)
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

const TAILSCALE = process.env.PAPERCLIP_TS_BROKER_TAILSCALE ?? "tailscale";
const PORT_MIN = Number(process.env.PAPERCLIP_TS_BROKER_PORT_MIN ?? 39000);
const PORT_MAX = Number(process.env.PAPERCLIP_TS_BROKER_PORT_MAX ?? 49999);
const PRIMARY_PORT = 443;
const PRIMARY_TARGET = process.env.PAPERCLIP_PRIMARY_TARGET ?? "http://127.0.0.1:3100";
const SOCKET = process.env.PAPERCLIP_TS_BROKER_SOCKET ?? "";

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures += 1;
  console.log(`  ✗ ${m}`);
};
const info = (m) => console.log(`  • ${m}`);

function ts(args) {
  return execFileSync(TAILSCALE, args, { encoding: "utf8", timeout: 10_000 });
}

console.log("Paperclip Tailscale HTTPS broker preflight (read-only)\n");

// 1. tailscale binary + version
console.log("Tailscale CLI");
try {
  const version = ts(["version"]).split("\n")[0].trim();
  pass(`tailscale available: ${version}`);
} catch (err) {
  fail(`tailscale CLI not runnable: ${err.message}`);
}

// 2. node DNS name + HTTPS enablement
console.log("Node identity");
let dnsName = null;
try {
  const status = JSON.parse(ts(["status", "--json"]));
  dnsName = (status.Self && status.Self.DNSName ? String(status.Self.DNSName) : "").replace(/\.$/, "");
  if (dnsName) pass(`MagicDNS node name: ${dnsName}`);
  else fail("could not resolve Self.DNSName from tailscale status");
  const magic = status.CurrentTailnet && status.CurrentTailnet.MagicDNSEnabled;
  if (magic) pass("MagicDNS enabled on tailnet");
  else info("MagicDNS flag not reported (HTTPS certs still require HTTPS to be enabled in the admin console)");
} catch (err) {
  fail(`tailscale status failed: ${err.message}`);
}

// 3. serve state + protected :443 invariant + range survey
console.log("Serve state");
try {
  const raw = ts(["serve", "status", "--json"]);
  const cfg = raw.trim() ? JSON.parse(raw) : {};
  const web = cfg && cfg.Web ? cfg.Web : {};
  const tcp = cfg && cfg.TCP ? cfg.TCP : {};
  const entries = {};
  for (const [key, value] of Object.entries(web)) {
    const portStr = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
    const port = Number(portStr);
    let target = null;
    if (value && value.Handlers && value.Handlers["/"] && typeof value.Handlers["/"].Proxy === "string") {
      target = value.Handlers["/"].Proxy;
    }
    entries[port] = { target, https: Boolean(tcp[String(port)] && tcp[String(port)].HTTPS) };
  }
  const primary = entries[PRIMARY_PORT];
  if (primary && primary.target === PRIMARY_TARGET && primary.https) {
    pass(`protected :${PRIMARY_PORT} -> ${PRIMARY_TARGET} (HTTPS) present`);
  } else {
    fail(`protected :${PRIMARY_PORT} -> ${PRIMARY_TARGET} mapping not found exactly (found: ${JSON.stringify(primary ?? null)})`);
  }
  const inRange = Object.keys(entries)
    .map(Number)
    .filter((p) => p >= PORT_MIN && p <= PORT_MAX);
  if (inRange.length === 0) info(`no existing serve mappings in dedicated range ${PORT_MIN}-${PORT_MAX}`);
  else info(`existing serve mappings in dedicated range: ${inRange.join(", ")} (broker adopts only exact-lease matches)`);
} catch (err) {
  fail(`tailscale serve status failed (read denied or unparseable): ${err.message}`);
}

// 4. broker socket parent directory safety (if configured)
if (SOCKET) {
  console.log("Broker socket");
  const parent = path.dirname(SOCKET);
  if (!existsSync(parent)) {
    info(`socket parent ${parent} does not exist yet (created at install)`);
  } else {
    try {
      const st = lstatSync(parent);
      if (st.isSymbolicLink()) fail(`socket parent ${parent} is a symlink`);
      else if ((st.mode & 0o022) !== 0) fail(`socket parent ${parent} is group/world-writable (${(st.mode & 0o777).toString(8)})`);
      else pass(`socket parent ${parent} is safe (${(st.mode & 0o777).toString(8)}, uid ${st.uid})`);
    } catch (err) {
      fail(`could not stat socket parent: ${err.message}`);
    }
  }
}

console.log("");
if (failures === 0) {
  console.log("Preflight OK: host is ready for the Paperclip Tailscale HTTPS broker.");
  process.exit(0);
}
console.log(`Preflight found ${failures} problem(s); resolve them before enabling tailscale_https exposure.`);
process.exit(1);
