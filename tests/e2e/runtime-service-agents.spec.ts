import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test as base, expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";
import { createLocalProcessHandoff } from "../../server/src/services/runtime-services/local-process-handoff";
import { readProcessStartedAt } from "../../server/src/services/hot-restart";

type Run = { runId: string; status: string; errorCode?: string };
const profile = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_PROFILE ?? "legacy-codex";
const native = profile.startsWith("runner-");
const appKind = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_APP ?? "vite";
if (!["vite", "storybook"].includes(appKind)) throw new Error(`Unknown service acceptance app: ${appKind}`);
const storybook = appKind === "storybook";
const serviceName = storybook ? "Agent Storybook preview" : "Agent React preview";
const acpx = profile === "legacy-acpx-codex";
const registerExisting = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_REGISTER_EXISTING === "1";
const warmPrelude = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_WARM_PRELUDE === "1";
if (warmPrelude && (!native || !registerExisting)) throw new Error("Warm ownership acceptance requires native Codex existing-process registration");
if (registerExisting && storybook) throw new Error("Existing-process model acceptance currently uses the Vite app");
const agentInstallsDependencies = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_INSTALL_DEPS === "1";
const terminateWarmRunner = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_KILL_WARM_RUNNER === "1";
const soakSeconds = Number(process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_SOAK_SECONDS ?? 0);
if (!Number.isInteger(soakSeconds) || (soakSeconds !== 0 && (soakSeconds < 330 || soakSeconds > 3600))) {
  throw new Error("Agent soak must be zero or between 330 and 3600 seconds so it outlasts the five-minute warm session");
}
if (terminateWarmRunner && (!native || soakSeconds > 0)) throw new Error("Unexpected runner exit acceptance requires a native runner and no idle-expiry soak");
if (warmPrelude && (terminateWarmRunner || soakSeconds > 0)) throw new Error("Warm ownership acceptance requires uninterrupted runner reuse");
const warm = native && (soakSeconds > 0 || terminateWarmRunner || warmPrelude);
if (warm && !process.env.PAPERCLIP_RUNNER_BINARY) throw new Error("Native warm-runner acceptance requires an explicit PAPERCLIP_RUNNER_BINARY for process ownership checks");
type RunnerProcess = { processPid: number; processStartedAt: string; finishedAt: string };
async function originalRunnerIsAlive(runner: RunnerProcess) {
  const startedAt = await readProcessStartedAt(runner.processPid).catch(() => null);
  if (startedAt !== runner.processStartedAt) return false;
  try {
    const command = await promisify(execFile)("ps", ["-p", String(runner.processPid), "-o", "comm="]);
    return command.stdout.trim() === process.env.PAPERCLIP_RUNNER_BINARY;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
async function json<T = any>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.url()}: HTTP ${response.status()}`).toBe(true);
  return response.json();
}
type Fixture = { cwd: string; companyId?: string; agentId?: string; issueId?: string; sourceReceipt?: Record<string, unknown> };
const test = base.extend<{ fixture: Fixture }>({
  fixture: [async ({ request }, use, testInfo) => {
    const fixture: Fixture = { cwd: await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-live-agent-")) };
    await use(fixture);
    // A test failure must not leave an agent launching new services behind the
    // browser's back. Terminate runs before enumerating their managed services.
    if (fixture.agentId) await json(await request.post(`/api/agents/${fixture.agentId}/pause`));
    if (fixture.issueId) {
      const runs = await json<Run[]>(await request.get(`/api/issues/${fixture.issueId}/runs`));
      for (const run of runs.filter((run) => !terminal.has(run.status))) {
        await json(await request.post(`/api/heartbeat-runs/${run.runId}/cancel`));
      }
      await expect.poll(async () => (await json<Run[]>(await request.get(`/api/issues/${fixture.issueId}/runs`))).every((run) => terminal.has(run.status)), { timeout: 30_000 }).toBe(true);
    }
    if (fixture.companyId) {
      const services = await json<RuntimeService[]>(await request.get(`/api/companies/${fixture.companyId}/runtime-services`));
      for (const service of services.filter((service) => !["stopped", "deleted"].includes(service.state))) {
        const url = `/api/companies/${fixture.companyId}/runtime-services/${service.id}`;
        await json(await request.post(`${url}/control`, { data: { action: "stop", expectedRevision: service.revision, requestId: randomUUID() } }));
        await expect.poll(async () => (await json<RuntimeService>(await request.get(url))).state, { timeout: 25_000 }).toBe("stopped");
      }
    }
    if (fixture.sourceReceipt) await createLocalProcessHandoff().stopExistingProcess(fixture.sourceReceipt);
    if (warm && fixture.issueId) {
      // Runs are terminal and their agent is paused. Close only runner processes
      // whose PID, observed start time, and executable still match this fixture.
      const runs = await json<Run[]>(await request.get(`/api/issues/${fixture.issueId}/runs`));
      const terminatedRunnerPids: number[] = [];
      for (const run of runs) {
        const runner = await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${run.runId}`));
        if (!Number.isInteger(runner.processPid) || runner.processPid <= 1 || !await originalRunnerIsAlive(runner)) continue;
        try { process.kill(runner.processPid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await expect.poll(() => originalRunnerIsAlive(runner), { timeout: 15_000 }).toBe(false);
        terminatedRunnerPids.push(runner.processPid);
      }
      if (terminatedRunnerPids.length > 0) {
        // Runner exit initiates asynchronous transport cleanup with a ten-second
        // close budget. Keep observing the actual server beyond that budget so
        // a late unhandled rejection cannot turn into a false passing scenario.
        const began = Date.now();
        let successfulHealthChecks = 0;
        do {
          await json(await request.get("/api/health", { timeout: 5_000 }));
          const services = await json<RuntimeService[]>(await request.get(`/api/companies/${fixture.companyId}/runtime-services`, { timeout: 5_000 }));
          expect(services.every((service) => ["stopped", "deleted"].includes(service.state))).toBe(true);
          successfulHealthChecks++;
          if (Date.now() - began >= 25_000) break;
          await delay(1_000);
        } while (true);
        await testInfo.attach("Server survives warm runner cleanup", {
          body: JSON.stringify({ terminatedRunnerPids, successfulHealthChecks, observedMs: Date.now() - began }),
          contentType: "application/json",
        });
      }
    }
    await fs.rm(fixture.cwd, { recursive: true, force: true });
  }, { timeout: 110_000 }],
});

async function completedRuns(request: APIRequestContext, issueId: string, count: number) {
  let runs: Run[] = [];
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    runs = await json<Run[]>(await request.get(`/api/issues/${issueId}/runs`));
    const failed = runs.find((run) => terminal.has(run.status) && run.status !== "succeeded");
    if (failed) throw new Error(`Agent run ${failed.runId} ended ${failed.status}: ${failed.errorCode ?? "unknown failure"}`);
    if (runs.length >= count && runs.every((run) => terminal.has(run.status))) break;
    await delay(2000);
  }
  expect(runs.filter((run) => run.status === "succeeded"), `Wait for ${count} actual agent run(s) to finish`).toHaveLength(count);
  expect(runs.every((run) => terminal.has(run.status))).toBe(true);
  for (const run of runs) {
    const detail = await json(await request.get(`/api/heartbeat-runs/${run.runId}`));
    expect(detail.runtimeMode).toBe(native ? "native" : "legacy");
    if (native) {
      expect(detail.driverKind).toBe("codex_app_server");
      expect(detail.runnerProfileJson.nativeExecutionInput.provider.kind).toBe("codex");
      expect(detail.runnerProfileJson.nativeExecutionInput.session.lifecyclePolicy).toMatchObject(warm
        ? { mode: "warm", idleTimeoutMs: 300_000 } : { mode: "per_turn" });
    }
  }
  return runs;
}

async function serviceToolCalls(request: APIRequestContext, runId: string) {
  if (native) {
    type Event = { seq: number; eventType: string; payload?: { prpEvent?: {
      runId: string; sourceKind: string; sourceInstanceId: string;
      payload?: { name?: string; status?: string; transport?: string };
    } } };
    const events: Event[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await json<Event[]>(await request.get(`/api/heartbeat-runs/${runId}/events?limit=1000&afterSeq=${afterSeq}`));
      if (!page.length) break;
      const next = page.at(-1)!.seq;
      expect(next).toBeGreaterThan(afterSeq);
      events.push(...page);
      afterSeq = next;
      expect(events.length, "Bound complete run-event evidence without silently truncating it").toBeLessThan(100_000);
    }
    return events.flatMap((event) => {
      const envelope = event.payload?.prpEvent;
      const call = envelope?.payload;
      return event.eventType === "tool.execution.completed" && envelope?.runId === runId
        && envelope.sourceKind === "runner" && envelope.sourceInstanceId && call?.transport === "dynamic" && call.name?.startsWith("services_")
        ? [{ tool: call.name, status: call.status ?? "unknown" }] : [];
    });
  }
  const log = await json<{ content: string }>(await request.get(`/api/heartbeat-runs/${runId}/log?limitBytes=1048576`));
  const output = log.content.split("\n").filter(Boolean).map((line) => {
    try { return String(JSON.parse(line).chunk ?? ""); } catch { return ""; }
  }).join("");
  return output.split("\n").flatMap((line): Array<{ tool: string; status: string }> => {
    try {
      const event = JSON.parse(line);
      if (acpx) {
        const tool = typeof event.name === "string" ? /(?:^|[.: /]|__)(services_(?:start|register|list|inspect|control|logs|update_policy))\b/.exec(event.name)?.[1] : undefined;
        return event.type === "acpx.tool_call" && tool ? [{ tool, status: event.status }] : [];
      }
      const item = event.item;
      return item?.type === "mcp_tool_call" && item.server === "paperclip-services"
        ? [{ tool: item.tool, status: item.status }] : [];
    } catch { return []; }
  });
}

test(`${profile}${registerExisting ? " registering an existing command" : ""}${warmPrelude ? " after a completed warm run" : ""}${agentInstallsDependencies ? " with agent dependency installation" : ""}${soakSeconds ? ` after ${soakSeconds}s away` : ""}${terminateWarmRunner ? " after unexpected warm runner exit" : ""}: real agent runs create a ${storybook ? "Storybook" : "Vite"} service and continue dirty files with ${storybook ? "live story updates" : "Fast Refresh"} after the first run ends`, async ({ page, request, context, fixture }, testInfo) => {
  test.skip(process.env.PAPERCLIP_RUNTIME_SERVICE_LIVE_CODEX !== "1", "Opt-in live model acceptance uses a signed-in isolated Codex home");
  test.setTimeout(600_000 + soakSeconds * 1000);
  const cwd = fixture.cwd;
  const dependencies = Object.fromEntries(await Promise.all(["vite", "@vitejs/plugin-react", "react", "react-dom", ...(storybook ? ["storybook", "@storybook/react-vite"] : [])].map(async (name) => [name,
    JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../../ui/node_modules", name, "package.json"), "utf8")).version,
  ])));
  if (!agentInstallsDependencies) {
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "live-agent-preview", private: true, type: "module", dependencies }));
    await promisify(execFile)("pnpm", ["install", "--ignore-workspace", "--prefer-offline", "--ignore-scripts"], { cwd, timeout: 90_000 });
  }
  await promisify(execFile)("git", ["init", "-q"], { cwd });
  const company = await json(await request.post("/api/companies", { data: { name: "Actual agent service acceptance" } }));
  fixture.companyId = company.id;
  const environments = await json<Array<{ id: string; driver: string }>>(await request.get(`/api/companies/${company.id}/environments?driver=local`));
  const local = environments.find((environment) => environment.driver === "local"); expect(local).toBeTruthy();
  let projectId: string | undefined;
  if (native) {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: true, enableIsolatedWorkspaces: true } }));
    const project = await json(await request.post(`/api/companies/${company.id}/projects`, { data: {
      name: "Agent preview workspace",
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize",
        allowIssueOverride: false, environmentId: local!.id, workspaceStrategy: { type: "project_primary" } },
      workspace: { name: "Primary", sourceType: "local_path", cwd, isPrimary: true },
    } }));
    projectId = project.id;
  }
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Service acceptance developer", role: "engineer", adapterType: native ? "paperclip_runner" : "codex_local", defaultEnvironmentId: local!.id,
    adapterConfig: native
      ? { lifecycleMode: warm ? "warm" : "per_turn", idleTimeoutMs: 300_000, provider: "codex", codexPermissionMode: "never" }
      : { engine: acpx ? "acp" : "cli", cwd, timeoutSec: 210, extraArgs: ["--skip-git-repo-check"] },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": [
      "You are exercising a local Paperclip acceptance fixture. Complete only the assigned task in its configured working directory.",
      registerExisting
        ? "This acceptance task specifically tests moving an already-running command to supervision. Launch the one requested original command, then use services_register/services_list/services_inspect. Do not create a second server or use services_control to work around a handoff failure. Verify readiness through services_inspect; the test harness performs browser and hot-reload acceptance, so do not launch another browser or explore other workspaces. Leave the resulting managed service running when the task ends."
        : "Use the injected services_start/services_list/services_inspect service tools for managed services. Do not launch unmanaged/background servers. Leave requested services running when the task ends.",
      "Do not delegate, create other tasks, commit files, read credentials, or print secrets. Do not ask questions.",
      native ? "Use the injected Paperclip task tools to report progress and complete the assigned task after verifying the work."
        : "Mark this task done after verifying the requested work through the Paperclip API using the injected authentication.",
    ].join("\n") } },
  } }));
  fixture.agentId = agent.id;
  // Saving an obsolete ACPX Codex native profile intentionally normalizes it
  // to native Codex. Never count a substituted provider as ACPX coverage.
  expect(agent.adapterConfig).toMatchObject(native ? { provider: "codex" } : { engine: acpx ? "acp" : "cli" });
  const prompt = [
    `Create a small ${storybook ? "React Storybook" : "Vite React app"} in the configured working directory ${cwd}.`,
    "Create .gitignore excluding node_modules, .pnpm-* and .paperclip-service-tmp. Keep application source files visible to Git.",
    agentInstallsDependencies
      ? `The workspace is empty except for .git. Write package.json with private:true, type:module and these exact dependencies: ${JSON.stringify(dependencies)}. Install them yourself using HOME="$PWD/.pnpm-home" XDG_STATE_HOME="$PWD/.pnpm-state" pnpm install --ignore-workspace --ignore-scripts --store-dir .pnpm-store --cache-dir .pnpm-cache --config.state-dir=.pnpm-state. Keep package-manager storage inside this workspace. Do not copy dependencies from another workspace.`
      : "Dependencies are already installed; do not reinstall them.",
    "App.jsx must export a React component with a useState counter, an h1 reading exactly 'Agent-created preview', and a button labelled 'Count 0' that increments when clicked.",
    storybook
      ? "Create App.stories.jsx importing App.jsx, exporting default {title:'Runtime/Counter',component:App} and export const Preview = {}. Create .storybook/main.js using framework:'@storybook/react-vite', stories:['../*.stories.jsx'], core:{disableTelemetry:true,allowedHosts:['.localhost']}, and viteFinal that merges server.watch:{usePolling:true,interval:300}, server.allowedHosts:['.localhost'], and resolve.dedupe:['react','react-dom'] into the supplied Vite config. Do not add addons. Keep React and ReactDOM deduplicated."
      : "Create index.html, main.jsx and vite.config.js. Use @vitejs/plugin-react and configure Vite server.watch to {usePolling:true,interval:300} so edits from later agent runs are observed inside the service sandbox.",
    registerExisting
      ? `Exercise existing-process registration: first launch this original command through your ordinary execution tool, with tty:true and a short yield so it stays running: printf '{"pid":%s}\\n' "$$" > .paperclip-registration-source.json; exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 0. Run it in ${cwd}. Do not background it with &, do not close its terminal, and do not kill it. Read the source PID from .paperclip-registration-source.json; verify the Vite startup output. Then call services_register with that numeric sourcePid, name '${serviceName}', purpose preview, endpoint name web, the same working folder, a request UUID, and command 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort'. Paperclip will stop the original command and relaunch it under supervision. Do not use services_start as a substitute. Wait for handoff.phase complete and the verified endpoint. If registration fails, inspect the message and fix the specific ownership/command-group issue without creating duplicate managed services.`
      : `Start a Paperclip managed service named '${serviceName}', purpose preview, for this task, using services_start. Use endpoint name web and the configured working directory. Generate a request UUID as required. Its command must be ${storybook ? 'node node_modules/storybook/dist/bin/dispatcher.js dev --ci --no-open --no-version-updates --disable-telemetry --host 127.0.0.1 --port "$PORT" --exact-port' : 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort'}.`,
    ...(storybook ? ["After the service endpoint is verified ready, write PREVIEW.md containing its verified Paperclip URL followed by /?path=/story/runtime-counter--preview. Return this specific story link in your final response."] : []),
    "Wait until the service is ready. Leave the service running and all source files uncommitted. Mark this task done and end your run.",
  ].join("\n");
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
    title: `Create and continue the agent ${appKind} preview`, description: warmPrelude
      ? `This is the warm-session preparation phase only. In ${cwd}, write warm-prelude.txt containing exactly 'Warm ownership prepared'. Do not create an app, start any server or call service tools yet. Mark the task done and end this run. A subsequent task update will provide the app instructions.`
      : prompt, status: "backlog", assigneeAgentId: agent.id,
    ...(projectId ? { projectId } : {}),
    ...(warmPrelude ? { executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "shared_workspace" } } : {}),
  } }));
  fixture.issueId = issue.id;
  await json(await request.patch(`/api/issues/${issue.id}`, { data: { status: "todo" } }));
  let preludeRun: Run | null = null;
  let preludeRunner: RunnerProcess | null = null;
  if (warmPrelude) {
    [preludeRun] = await completedRuns(request, issue.id, 1);
    preludeRunner = await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${preludeRun!.runId}`));
    expect(await originalRunnerIsAlive(preludeRunner), "The preparation run leaves its verified runner alive").toBe(true);
    expect((await fs.readFile(path.join(cwd, "warm-prelude.txt"), "utf8")).trim()).toBe("Warm ownership prepared");
    expect(await json<RuntimeService[]>(await request.get(`/api/companies/${company.id}/runtime-services`))).toEqual([]);
    await json(await request.post(`/api/issues/${issue.id}/comments`, { data: { body: prompt, reopen: true } }));
  }
  // Capture only a source whose OS ancestry matches this fixture's real run.
  // This gives failed-test cleanup a verified claim, never an agent-supplied PID.
  let capturing = registerExisting;
  const captureSource = (async () => {
    while (capturing && !fixture.sourceReceipt) {
      try {
        const source = JSON.parse(await fs.readFile(path.join(cwd, ".paperclip-registration-source.json"), "utf8"));
        const runs = await json<Run[]>(await request.get(`/api/issues/${issue.id}/runs`));
        const run = runs.find((item) => item.status === "running");
        if (run) {
          const owner = await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${run.runId}`));
          if (owner.processPid && owner.processStartedAt) fixture.sourceReceipt = (await createLocalProcessHandoff().captureExistingProcess({ pid: source.pid, owner: { pid: owner.processPid, startedAt: owner.processStartedAt }, cwd, workspaceRoot: cwd })).receipt;
        }
      } catch { /* The source file or command may not exist yet. */ }
      if (capturing && !fixture.sourceReceipt) await delay(250);
    }
  })();
  let firstRuns: Run[];
  try { firstRuns = (await completedRuns(request, issue.id, preludeRun ? 2 : 1)).filter(run => run.runId !== preludeRun?.runId); }
  finally { capturing = false; await captureSource; }
  const firstCalls = await serviceToolCalls(request, firstRuns[0]!.runId);
  if (preludeRunner) {
    const registrationRunner = await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${firstRuns[0]!.runId}`));
    expect(registrationRunner, "Registration uses the same warm runner under the new run's ownership").toMatchObject({ processPid: preludeRunner.processPid, processStartedAt: preludeRunner.processStartedAt });
  }
  expect(firstCalls).toContainEqual({ tool: registerExisting ? "services_register" : "services_start", status: "completed" });
  if (registerExisting) {
    expect(firstCalls.some((call) => ["services_start", "services_control"].includes(call.tool)), "Registration must complete without substituting creation or recovering through Stop/Start").toBe(false);
    expect(fixture.sourceReceipt, "Capture the actual original command's ownership before handoff").toBeDefined();
    const originalStartedAt = await readProcessStartedAt(Number(fixture.sourceReceipt!.groupId)).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      if ((process.platform === "darwin" && code === 1) || (process.platform === "linux" && code === "ENOENT")) return null;
      throw error;
    });
    expect(originalStartedAt, "The original command must have exited").toBeNull();
  }
  if (agentInstallsDependencies) {
    expect(JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"))).toMatchObject({ dependencies });
    expect(await fs.readFile(path.join(cwd, "pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion:");
    expect(JSON.parse(await fs.readFile(path.join(cwd, "node_modules/react/package.json"), "utf8")).version).toBe(dependencies.react);
  }
  expect((await json(await request.get(`/api/issues/${issue.id}`))).status).toBe("done");
  const services = await json<RuntimeService[]>(await request.get(`/api/companies/${company.id}/runtime-services`));
  expect(services).toHaveLength(1);
  const service = services[0]!;
  expect(service).toMatchObject({ name: serviceName, startedByRunId: firstRuns[0]!.runId, createdByAgentId: agent.id, issueId: issue.id });
  const servicePath = `/api/companies/${company.id}/runtime-services/${service.id}`;
  const read = async () => json<RuntimeService>(await request.get(servicePath));
  await expect.poll(async () => (await read()).endpoints[0]?.status, { timeout: 40_000 }).toBe("ready");
  if (registerExisting) expect(await read()).toMatchObject({ handoff: { mode: "relaunch", phase: "complete" }, restartCount: 0 });
  const stableUrl = (await read()).endpoints[0]!.url!;
  const startedAt = (await read()).startedAt;
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  await expect(page.getByRole("link", { name: serviceName, exact: true }).first()).toBeVisible();
  await page.goto(`/${company.issuePrefix}/runtime-services/${service.id}`);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Open web", exact: true }).click();
  const preview = await opened;
  let storyUrl: string | null = null;
  if (storybook) {
    storyUrl = `${stableUrl}/?path=/story/runtime-counter--preview`;
    expect(await fs.readFile(path.join(cwd, "PREVIEW.md"), "utf8")).toContain(storyUrl);
    const firstRunDetail = await json(await request.get(`/api/heartbeat-runs/${firstRuns[0]!.runId}`));
    expect(firstRunDetail.resultJson?.summary, "The agent returns the specific story link to the user").toContain(storyUrl);
    await testInfo.attach("Storybook configuration", { body: await fs.readFile(path.join(cwd, ".storybook/main.js")), contentType: "text/javascript" });
    await preview.goto(storyUrl);
  }
  const app = storybook ? preview.frameLocator("#storybook-preview-iframe") : preview;
  const browserEvents: Array<{ at: string; event: string; detail: string }> = [];
  preview.on("console", (message) => {
    if (message.text().startsWith("[vite]") && browserEvents.length < 200) browserEvents.push({ at: new Date().toISOString(), event: "console", detail: message.text() });
  });
  preview.on("framenavigated", (frame) => {
    if (frame === preview.mainFrame() && browserEvents.length < 200) browserEvents.push({ at: new Date().toISOString(), event: "navigation", detail: new URL(frame.url()).pathname });
  });
  await expect(app.getByRole("heading", { name: "Agent-created preview", exact: true })).toBeVisible();
  await app.getByRole("button", { name: "Count 0", exact: true }).click();
  await app.getByRole("button", { name: "Count 1", exact: true }).click();
  await fs.writeFile(path.join(cwd, "operator-note.txt"), "Keep this dirty file across agent runs.\n");
  const originalApp = await fs.readFile(path.join(cwd, "App.jsx"), "utf8");
  let warmRunnerExitedAfterMs: number | null = null;
  let terminatedRunner: RunnerProcess | null = null;
  if (terminateWarmRunner) {
    terminatedRunner = await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${firstRuns[0]!.runId}`));
    expect(await originalRunnerIsAlive(terminatedRunner), "The completed run leaves its verified fixture runner warm").toBe(true);
    // Inject failure only into this fixture's verified process, while no agent
    // turn is active. Do not use Paperclip's shutdown path or kill a process group.
    process.kill(terminatedRunner.processPid, "SIGKILL");
    await expect.poll(() => originalRunnerIsAlive(terminatedRunner!), { timeout: 15_000 }).toBe(false);
    const began = Date.now();
    do {
      await json(await request.get("/api/health", { timeout: 5_000 }));
      expect(await read()).toMatchObject({ state: "ready", startedAt, endpoints: [expect.objectContaining({ url: stableUrl, status: "ready" })] });
      await expect(app.getByRole("button", { name: "Count 2", exact: true })).toBeVisible();
      if (Date.now() - began >= 25_000) break;
      await delay(1_000);
    } while (true);
    await testInfo.attach("Preview survives unexpected runner exit", { body: JSON.stringify({ processPid: terminatedRunner.processPid, processStartedAt: terminatedRunner.processStartedAt, finishedAt: terminatedRunner.finishedAt, signal: "SIGKILL", observedMs: Date.now() - began }), contentType: "application/json" });
  }
  if (soakSeconds > 0) {
    const runner = warm ? await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${firstRuns[0]!.runId}`)) : null;
    if (runner) expect(await originalRunnerIsAlive(runner), "The completed run initially leaves its runner warm").toBe(true);
    const began = Date.now();
    const runFinishedAt = runner ? Date.parse(runner.finishedAt) : began;
    expect(Number.isFinite(runFinishedAt)).toBe(true);
    await preview.bringToFront();
    while (Date.now() - began < soakSeconds * 1000) {
      await delay(Math.min(10_000, soakSeconds * 1000 - (Date.now() - began)));
      const current = await read();
      expect(current).toMatchObject({ state: "ready", startedAt, endpoints: [expect.objectContaining({ url: stableUrl, status: "ready" })] });
      expect(current.previewActivity?.lastSignalAt).toBeTruthy();
      expect(Date.now() - Date.parse(current.previewActivity!.lastSignalAt!)).toBeLessThan(45_000);
      if (runner && warmRunnerExitedAfterMs === null && !await originalRunnerIsAlive(runner)) warmRunnerExitedAfterMs = Date.now() - runFinishedAt;
    }
    if (runner) {
      expect(warmRunnerExitedAfterMs, "The five-minute warm runner must have actually exited").not.toBeNull();
      expect(warmRunnerExitedAfterMs!).toBeGreaterThan(270_000);
      expect(warmRunnerExitedAfterMs!).toBeLessThan(330_000);
    }
    await expect(app.getByRole("button", { name: "Count 2", exact: true })).toBeVisible();
  }
  await json(await request.post(`/api/issues/${issue.id}/comments`, { data: { reopen: true, body: [
    "Continue in the same working directory with the already-running managed service. Read operator-note.txt and preserve it exactly.",
    "Change only the h1 text in App.jsx to exactly 'Edited by the next agent run'. Preserve the component and counter structure so React Fast Refresh keeps its state.",
    "Use services_list or services_inspect to verify the existing service. Do not create another service or restart it. Leave dirty files uncommitted, leave the service running, mark the task done, and end this run.",
  ].join("\n") } }));
  const allRuns = await completedRuns(request, issue.id, preludeRun ? 3 : 2);
  const secondRun = allRuns.find((run) => run.runId !== firstRuns[0]!.runId && run.runId !== preludeRun?.runId)!;
  if (preludeRunner) {
    const editingRunner = await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${secondRun.runId}`));
    expect(editingRunner, "The editing run retains the same warm process identity").toMatchObject({ processPid: preludeRunner.processPid, processStartedAt: preludeRunner.processStartedAt });
  }
  if (terminatedRunner) {
    const replacement = await json<RunnerProcess>(await request.get(`/api/heartbeat-runs/${secondRun.runId}`));
    expect(replacement.processStartedAt, "The second run uses a newly started runner").not.toBe(terminatedRunner.processStartedAt);
    expect(await originalRunnerIsAlive(replacement)).toBe(true);
  }
  const secondCalls = await serviceToolCalls(request, secondRun.runId);
  expect(secondCalls.some((call) => ["services_list", "services_inspect"].includes(call.tool) && call.status === "completed")).toBe(true);
  const currentService = await read();
  const editedApp = await fs.readFile(path.join(cwd, "App.jsx"), "utf8");
  await testInfo.attach("Actual agent run continuity", { body: JSON.stringify({ companyId: company.id, issueId: issue.id,
    profile, appKind, storyUrl, registerExisting, warmPrelude, preludeRunner, agentInstallsDependencies, soakSeconds, warmRunnerExitedAfterMs, terminateWarmRunner, serviceId: service.id,
    runIds: allRuns.map((run) => run.runId), serviceToolCalls: [firstCalls, secondCalls],
    originalStartedAt: startedAt, service: currentService, browserEvents, originalApp, editedApp, stableUrl }, null, 2), contentType: "application/json" });
  // Editors may normalize a final blank line. Preserve the actual component
  // body and separately verify Fast Refresh retains its live browser state.
  expect(editedApp.trimEnd()).toBe(originalApp.replace("Agent-created preview", "Edited by the next agent run").trimEnd());
  await expect(app.getByRole("heading", { name: "Edited by the next agent run", exact: true })).toBeVisible({ timeout: 25_000 });
  // Storybook re-evaluates its story module and remounts the component on HMR.
  // A direct-server baseline with the same packages reproduces that reset.
  // Vite's standalone React app must retain its Fast Refresh state.
  await expect(app.getByRole("button", { name: storybook ? "Count 0" : "Count 2", exact: true })).toBeVisible();
  if (storybook) {
    await app.getByRole("button", { name: "Count 0", exact: true }).click();
    await expect(app.getByRole("button", { name: "Count 1", exact: true })).toBeVisible();
  }
  expect(await fs.readFile(path.join(cwd, "operator-note.txt"), "utf8")).toBe("Keep this dirty file across agent runs.\n");
  expect((await promisify(execFile)("git", ["status", "--porcelain"], { cwd })).stdout).toContain("App.jsx");
  expect(await read()).toMatchObject({ state: "ready", startedAt, endpoints: [expect.objectContaining({ url: stableUrl, status: "ready" })] });
  expect(await json<RuntimeService[]>(await request.get(`/api/companies/${company.id}/runtime-services`))).toHaveLength(1);
  expect(new URL(preview.url()).origin).toBe(stableUrl);
  if (storybook) expect(new URL(preview.url()).searchParams.get("path")).toBe("/story/runtime-counter--preview");
  await preview.screenshot({ path: testInfo.outputPath("agent-run-fast-refresh.png"), fullPage: true });
});
