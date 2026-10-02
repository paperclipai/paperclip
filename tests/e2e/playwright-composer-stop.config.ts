import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Opt-in native coverage uses real runnerd with the repo's deterministic Codex
// protocol fixture. Never let this suite fall through to a logged-in real Codex.
const fixture = process.env.PAPERCLIP_STOP_FAKE_CODEX;
const fixtureDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "composer-stop-provider-"),
);
const logPath =
  process.env.PAPERCLIP_STOP_CODEX_LOG ??
  path.join(fixtureDir, "codex-calls.log");
process.env.PAPERCLIP_STOP_CODEX_LOG = logPath;
if (fixture) {
  if (!path.isAbsolute(fixture) || !fs.existsSync(fixture))
    throw new Error(
      "PAPERCLIP_STOP_FAKE_CODEX must name the built fake-codex-app-server binary",
    );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(
    path.join(fixtureDir, "codex"),
    `#!/bin/sh\nexec ${quote(fixture)} --state-file ${quote(fixtureDir)}/state-$$.json --hold-turn --call-log ${quote(logPath)} "$@"\n`,
    { mode: 0o755 },
  );
}
const server = base.webServer as Exclude<typeof base.webServer, unknown[]>;
export default defineConfig({
  ...base,
  testMatch: "composer-stop.spec.ts",
  timeout: 90_000,
  webServer: {
    ...server,
    env: {
      ...server?.env,
      HEARTBEAT_SCHEDULER_INTERVAL_MS: "10000",
      PATH: `${fixtureDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  },
});
