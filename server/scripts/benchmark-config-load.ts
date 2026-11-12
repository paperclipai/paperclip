import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const calls = Number(argument("--calls") ?? 200);
assert.ok(Number.isInteger(calls) && calls >= 1 && calls <= 100_000, "--calls must be an integer from 1 to 100000");
assert.notEqual(process.platform, "win32", "the counting tailscale stand-in needs a POSIX shell");

const TAILNET_ADDRESS = "100.64.0.1";
const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-config-load-benchmark-"));
const configPath = path.join(home, "config.json");
const execLogPath = path.join(home, "tailscale-execs.log");
const binDir = path.join(home, "bin");

function isolateEnvironment() {
  for (const name of [
    "PAPERCLIP_BIND", "PAPERCLIP_BIND_HOST", "PAPERCLIP_TAILNET_BIND_HOST", "HOST", "PAPERCLIP_DEPLOYMENT_MODE",
    "PAPERCLIP_DEPLOYMENT_EXPOSURE", "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_MANAGED_CONFIG",
    "PAPERCLIP_STORAGE_PROVIDER", "DATABASE_URL",
  ]) delete process.env[name];
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  process.env.PAPERCLIP_CONFIG = configPath;
  if (!process.env.PATH?.startsWith(binDir)) process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
}

function writeConfig(server: Record<string, unknown>) {
  writeFileSync(configPath, JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-11-11T00:00:00.000Z", source: "configure" },
    database: { mode: "embedded-postgres" },
    logging: { mode: "file" },
    server,
  }));
}

const tailscaleExecs = () => existsSync(execLogPath) ? readFileSync(execLogPath, "utf8").split("\n").filter(Boolean).length : 0;

try {
  isolateEnvironment();
  writeConfig({});
  mkdirSync(binDir);
  const standIn = path.join(binDir, "tailscale");
  writeFileSync(standIn, `#!/bin/sh\necho exec >> '${execLogPath}'\necho ${TAILNET_ADDRESS}\n`);
  chmodSync(standIn, 0o755);

  const { loadConfig } = await import("../src/config.js");
  const { getStorageService } = await import("../src/storage/index.js");
  isolateEnvironment();

  const scenarios: Array<{ name: string; server: Record<string, unknown>; expectedHost: string; run: () => void }> = [
    { name: "loadConfig, bind=lan (hosted shape)", server: { deploymentMode: "authenticated", exposure: "private", bind: "lan" },
      expectedHost: "0.0.0.0", run: () => { loadConfig(); } },
    { name: "getStorageService, bind=lan", server: { deploymentMode: "authenticated", exposure: "private", bind: "lan" },
      expectedHost: "0.0.0.0", run: () => { getStorageService(); } },
    { name: "loadConfig, default loopback", server: {}, expectedHost: "127.0.0.1", run: () => { loadConfig(); } },
    { name: "loadConfig, bind=tailnet", server: { deploymentMode: "authenticated", exposure: "private", bind: "tailnet" },
      expectedHost: TAILNET_ADDRESS, run: () => { loadConfig(); } },
  ];

  const rows = scenarios.map((scenario) => {
    writeConfig(scenario.server);
    const execsBefore = tailscaleExecs();
    const started = process.hrtime.bigint();
    for (let index = 0; index < calls; index += 1) scenario.run();
    const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
    const execs = tailscaleExecs() - execsBefore;
    assert.equal(loadConfig().host, scenario.expectedHost, `${scenario.name}: resolved bind host`);
    return {
      scenario: scenario.name,
      calls,
      "tailscale execs": execs,
      "total ms (event loop blocked)": Number(totalMs.toFixed(1)),
      "ms per call": Number((totalMs / calls).toFixed(3)),
    };
  });
  console.table(rows);
  console.log(`node ${process.version}, ${os.platform()} ${os.arch()}, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
