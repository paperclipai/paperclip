import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const patterns = { "--tool-removal-only": "public tool removal retains Slack retirement", "--fairness-only": "two due registrations", "--malformed-only": "malformed sealed Slack receipt",
  "--wiring-only": "normal configure stages SQL intent", "--cas-only": "real SQL refuses an enrollment response" };
const args = process.argv.slice(2);
if (!process.version.startsWith("v24.")) throw new Error("Slack owner fixture requires the current Node24 executable");
if (args.length > 1 || args.length && !Object.hasOwn(patterns, args[0])) throw new Error("Unknown Slack owner fixture selector");
const value = process.env.PAPERCLIP_SLACK_OWNER_TEST_DATABASE_URL;
if (!value) throw new Error("Set PAPERCLIP_SLACK_OWNER_TEST_DATABASE_URL to the exact owned external test database");
const fixture = new URL(value), admin = new URL(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL ?? "invalid:");
if (!["postgres:", "postgresql:"].includes(fixture.protocol) || fixture.hostname !== "127.0.0.1" || fixture.port !== "55448"
  || !/^[a-zA-Z0-9_]+_test$/.test(fixture.pathname.slice(1)) || fixture.search || fixture.hash
  || admin.protocol !== fixture.protocol || admin.hostname !== fixture.hostname || admin.port !== fixture.port
  || admin.pathname !== "/postgres" || admin.search || admin.hash) throw new Error("Slack owner fixture requires its explicit owned PG17 URL/admin grant");
const log = process.env.SLACK_GATE_PROCESS_LOG;
if (!log || !path.isAbsolute(log) || existsSync(log)) throw new Error("Slack owner fixture requires a fresh absolute guard log");
const server = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const guard = path.join(server, "src/__tests__/helpers/slack-cloud/prewire.cjs");
const home = mkdtempSync(path.join(tmpdir(), "slack-owner-fixture-"));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, LANG: process.env.LANG,
  TMPDIR: home, PAPERCLIP_HOME: home, NODE_ENV: "test", NODE_OPTIONS: "", SLACK_GATE_EXPECT_PRELOAD: "1",
  PAPERCLIP_SLACK_OWNER_TEST_DATABASE_URL: value, PAPERCLIP_SLACK_TEST_DATABASE_URL: value,
  PAPERCLIP_TEST_POSTGRES_ADMIN_URL: process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL, SLACK_GATE_PROCESS_LOG: log };
const child = spawn(process.execPath, ["--require", guard, vitest, "run", "src/__tests__/slack-cloud-owner-work.test.ts",
  "--maxWorkers=1", "--no-file-parallelism", `--execArgv=--require=${guard}`,
  ...(args.length ? [`--testNamePattern=${patterns[args[0]]}`] : [])], { cwd: server, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("close", (code, signal) => { rmSync(home, { recursive: true, force: true }); process.exitCode = signal ? 1 : code ?? 1; });
