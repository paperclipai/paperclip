import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.version.startsWith("v24.")) throw new Error("Slack form journey requires the current Node24 executable");
if (process.argv.length !== 2) throw new Error("Slack form journey has one closed complete case and accepts no selectors");
const value = process.env.PAPERCLIP_SLACK_TEST_DATABASE_URL;
const cloudValue = process.env.SLACK_EVENT_TEST_DATABASE_URL;
const fixture = new URL(value ?? "invalid:"), cloud = new URL(cloudValue ?? "invalid:"), admin = new URL(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL ?? "invalid:");
for (const url of [fixture, cloud, admin]) if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || !url.port || url.search || url.hash) throw new Error("Explicit owned PG17 fixture/admin URLs required");
if (fixture.protocol !== cloud.protocol || fixture.protocol !== admin.protocol || admin.pathname !== "/postgres"
  || !/^\/sleep2_slack_form_[a-z0-9_]+_app_test$/.test(fixture.pathname) || cloud.pathname !== fixture.pathname.replace(/_app_test$/, "_cloud_test")) throw new Error("Distinct same-grant form fixture pair required");
const stateFile = process.env.SLACK_FORM_JOURNEY_STATE_FILE;
if (!stateFile || !path.isAbsolute(stateFile)) throw new Error("Owned private host state file required");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const peer = new URL(state.origin), tenant = new URL(state.tenantOrigin);
for (const url of [peer, tenant]) if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || ["55448", "5432"].includes(url.port) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Closed loopback HTTP peer origin required");
if (peer.origin === tenant.origin) throw new Error("Cloud and tenant must have distinct owned listeners");
const log = process.env.SLACK_GATE_PROCESS_LOG;
if (!log || !path.isAbsolute(log) || existsSync(log)) throw new Error("Fresh absolute guard log required");
const packet = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(packet, "../../../..");
const mode = process.env.SLACK_FORM_SHORT_GATE;
if (mode !== "callback") throw new Error("One existing closed HTTP mode required");
const entry = path.join(server, "src/__tests__/slack-enabled-quiet.postgres.test.ts");
const require = createRequire(path.join(server,"package.json"));
const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const guard = path.join(packet, "quiet-prewire.cjs");
const home = mkdtempSync(path.join(tmpdir(), "slack-form-journey-"));
const env = { PATH: process.env.PATH, LANG: process.env.LANG, HOME: home, TMPDIR: home, PAPERCLIP_HOME: home,
  NODE_ENV: "test", NODE_OPTIONS: "", SLACK_GATE_EXPECT_PRELOAD: "1", PAPERCLIP_SLACK_TEST_DATABASE_URL: value,
  SLACK_EVENT_TEST_DATABASE_URL: cloudValue, PAPERCLIP_TEST_POSTGRES_ADMIN_URL: process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL,
  SLACK_GATE_PROCESS_LOG: log, SLACK_FORM_JOURNEY_STATE_FILE: stateFile, SLACK_FORM_FIXTURE_PEER_ORIGIN: peer.origin, SLACK_FORM_SHORT_GATE: process.env.SLACK_FORM_SHORT_GATE, SLACK_PUBLICATION_REPORT: process.env.SLACK_PUBLICATION_REPORT };
if (env.SLACK_FORM_SHORT_GATE !== "callback") throw new Error("One closed short gate required");
const config = path.join(home,"short-gate.config.ts");
writeFileSync(config, `import base from ${JSON.stringify(path.join(server,"vitest.config.ts"))};\nexport default {...base,root:${JSON.stringify(server)},test:{...base.test,include:[${JSON.stringify(entry)}],exclude:[],maxWorkers:1,fileParallelism:false}};\n`);
const child = spawn(process.execPath, ["--require", guard, vitest, "run", "--config", config,
  "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", "--reporter=json", "--outputFile=" + process.env.SLACK_PUBLICATION_REPORT, `--execArgv=--require=${guard}`], { cwd: server, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("close", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; if (!process.exitCode) rmSync(home, { recursive: true, force: true }); });
