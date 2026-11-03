import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const repository = process.argv[2];
const expectedRevision = process.argv[3];
const evidenceDir = process.argv[4];
if (!repository || !expectedRevision || !evidenceDir) throw new Error("repository, expected revision and evidence directory are required");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
if (revision !== expectedRevision) throw new Error("Source revision changed before live acceptance");
const buildStamp = JSON.parse(await readFile(join(repository, "server/dist/build-info.json"), "utf8"));
if (buildStamp.commit !== expectedRevision) throw new Error("Compiled server revision does not match live acceptance source");
const credentialName = "PAPERCLIP_PI_QUALIFICATION_OPENROUTER_API_KEY";
if (!process.env[credentialName]) throw new Error("Qualification credential is unavailable");
const model = "openrouter/deepseek/deepseek-v4-flash-0731";
await mkdir(evidenceDir, { recursive: true });
const dataDir = await mkdtemp("/private/tmp/paperclip-native-live-data-");
let server;
try {
  const { prepareTestDriveEnvironment, bootstrapTestDrive } = await import(pathToFileURL(join(repository, "cli/src/commands/test-drive.ts")).href);
  const options = { dataDir, companyName: "Native ingestion live acceptance", agentName: "Live ingestion agent",
    harness: "opencode", model, apiKeyEnv: credentialName, browser: false };
  const { linkedWorktree } = await prepareTestDriveEnvironment(options, repository);
  process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "false";
  process.env.NODE_ENV = "production";
  process.env.SERVE_UI = "true";
  const { onboard } = await import(pathToFileURL(join(repository, "cli/src/commands/onboard.ts")).href);
  await onboard({ config: process.env.PAPERCLIP_CONFIG, yes: true, bind: "loopback", invokedByRun: true, installService: false });
  const { doctor } = await import(pathToFileURL(join(repository, "cli/src/commands/doctor.ts")).href);
  const checked = await doctor({ config: process.env.PAPERCLIP_CONFIG, repair: true, yes: true });
  if (checked.failed > 0) throw new Error(`Doctor failed ${checked.failed} checks`);
  const { startServer } = await import(pathToFileURL(join(repository, "server/dist/index.js")).href);
  server = await startServer();
  const origin = `http://${server.host}:${server.listenPort}`;
  const { PaperclipApiClient } = await import(pathToFileURL(join(repository, "cli/src/client/http.ts")).href);
  const api = new PaperclipApiClient({ apiBase: origin });
  const fixture = await bootstrapTestDrive({ api, options, linkedWorktree,
    instanceId: process.env.PAPERCLIP_INSTANCE_ID ?? "default", env: process.env });
  if (fixture.reused || !fixture.agent) throw new Error("Fresh live-provider fixture was not created");
  await api.patch("/api/instance/settings/experimental", { enableNativeRunner: true });
  const agent = await api.patch(`/api/agents/${fixture.agent.id}`, {
    adapterType: "paperclip_runner",
    adapterConfig: { ...fixture.agent.adapterConfig, provider: "opencode", model, lifecycleMode: "per_turn",
      opencodePermissionMode: "allow", timeoutSec: 180 },
    runtimeConfig: { heartbeat: { enabled: false } },
  });
  if (agent?.adapterType !== "paperclip_runner" || agent.adapterConfig?.provider !== "opencode") throw new Error("Native agent setup did not persist");
  const config = { repository, origin, company: { id: fixture.company.id, issuePrefix: fixture.company.issuePrefix },
    agent: { id: agent.id, name: agent.name }, evidenceDir, revision, dataDir, pid: process.pid,
    build: { commit: buildStamp.commit, serverSha256: createHash("sha256").update(await readFile(join(repository, "server/dist/index.js"))).digest("hex"),
      uiSha256: createHash("sha256").update(await readFile(join(repository, "ui/dist/index.html"))).digest("hex") },
    platform: { node: process.version, os: process.platform, architecture: process.arch }, provider: { kind: "opencode", model } };
  await writeFile(join(evidenceDir, "live-launch.json"), JSON.stringify(config, null, 2));
  console.log(JSON.stringify({ ready: true, origin, revision, evidenceDir, configPath: join(evidenceDir, "live-launch.json"), pid: process.pid }));
} catch (error) {
  await server?.shutdown?.("SIGTERM");
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message.replaceAll(process.env[credentialName] ?? "\0private-credential-unavailable", "***REDACTED***"));
  process.exitCode = 1;
}
