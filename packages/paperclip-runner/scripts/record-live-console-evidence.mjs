import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerDriver,
  LiveConsoleDemoServer,
} from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(resolve(
  process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(),
  "live-console-real-codex-",
));
const requestedOutput = process.argv.slice(2).find((argument) => argument !== "--");
const output = resolve(
  packageRoot,
  requestedOutput ?? "knowledge/evidence/live-console-real-codex-server.json",
);

const server = new LiveConsoleDemoServer({
  host: "127.0.0.1",
  port: 0,
  workingDirectory: workspace,
  driverFactory: (taskEnvelope) => new CodexAppServerDriver({
    taskEnvelope,
    environment: { ...process.env, PAPERCLIP_WORKSPACE_CWD: workspace },
  }),
});

const address = await server.start();
const directApiAuthorization = server.directApiAuthorization();
const commandLog = [];

async function request(path, init) {
  commandLog.push({ method: init?.method ?? "GET", path });
  const response = await fetch(`${address.url}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      authorization: directApiAuthorization,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function post(path, body) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function normalize(value) {
  if (typeof value === "string") return value.replaceAll(workspace, "<live-console-workspace>");
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
}

try {
  const health = await request("/api/liveConsole/health");
  const created = await post("/api/liveConsole/sessions", {
    objective: "Create liveConsole.txt with exactly: liveConsole real codex evidence",
    message: "Complete the exact file task, verify it, and return the semantic result.",
  });
  const sessionId = created.sessionId;
  const turnId = created.activeTurnId;
  let goalSet;
  let goalPause;
  let goalResume;
  if (created.capabilities?.goals === true) {
    goalSet = await post(`/api/liveConsole/sessions/${sessionId}/goal/set`, {
      objective: "Complete the Live console real Codex evidence turn",
      tokenBudget: 8192,
    });
    goalPause = await post(`/api/liveConsole/sessions/${sessionId}/goal/pause`, {});
    goalResume = await post(`/api/liveConsole/sessions/${sessionId}/goal/resume`, {});
  } else {
    const unsupported = { supported: false, diagnostic: "capability not advertised" };
    goalSet = unsupported;
    goalPause = unsupported;
    goalResume = unsupported;
  }
  let steer;
  try {
    steer = await post(`/api/liveConsole/sessions/${sessionId}/steer`, {
      turnId,
      text: "Keep the file content exact and include the verification in the semantic result.",
    });
  } catch (error) {
    steer = { race: "already_terminal", diagnostic: String(error) };
  }

  const deadline = Date.now() + 120_000;
  let replay;
  while (Date.now() < deadline) {
    replay = await request(`/api/liveConsole/sessions/${sessionId}/events?after=0`);
    if (replay.events.some((event) => [
      "turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled",
    ].includes(event.eventType))) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!replay?.events.some((event) => [
    "turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled",
  ].includes(event.eventType))) {
    throw new Error("real Live console turn did not terminalize before the timeout");
  }
  const beforeReconnect = await request(`/api/liveConsole/sessions/${sessionId}`);
  const reconnected = await post(`/api/liveConsole/sessions/${sessionId}/reconnect`, {});
  const afterReconnect = await request(
    `/api/liveConsole/sessions/${sessionId}/events?after=${replay.cursor}`,
  );
  const fileText = await readFile(resolve(workspace, "liveConsole.txt"), "utf8");
  const serialized = JSON.stringify({
    health,
    created,
    goalSet,
    goalPause,
    goalResume,
    steer,
    replay,
    beforeReconnect,
    reconnected,
    afterReconnect,
  });
  const secretValues = [process.env.PAPERCLIP_API_KEY, process.env.OPENAI_API_KEY]
    .filter((value) => typeof value === "string" && value.length > 0);
  const events = replay.events;
  const sessionContext = events.find((event) => event.eventType === "session.started")
    ?.payload?.context;
  const codexVersion = typeof sessionContext?.codexVersion === "string"
    ? sessionContext.codexVersion
    : "not reported";
  const evidence = normalize({
    schema: "paperclip.runner.live-console.real-evidence.v1",
    recordedAt: new Date().toISOString(),
    codexVersion,
    server: {
      host: address.host,
      port: address.port,
      providerAuthentication: health.providerAuthentication,
      credentialsExposed: health.credentialsExposed,
    },
    commandLog,
    identity: {
      sessionId,
      runId: created.runId,
      normalizedSessionId: created.normalizedSessionId,
      driverSession: created.driverSession,
      reconnectedDriverSession: reconnected.driverSession,
    },
    capabilities: reconnected.capabilities,
    goals: {
      set: goalSet.goal ?? goalSet,
      paused: goalPause.goal ?? goalPause,
      resumed: goalResume.goal ?? goalResume,
    },
    steering: steer,
    file: { path: "liveConsole.txt", text: fileText },
    events,
    reconnectEvents: afterReconnect.events,
    assertions: {
      exactFile: fileText === "liveConsole real codex evidence",
      semanticResult: events.filter((event) => event.eventType === "run.result.proposed").length === 1,
      oneTurnTerminal: events.filter((event) => [
        "turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled",
      ].includes(event.eventType)).length === 1,
      continuousSourceSequence: events.every((event, index) => event.sourceSeq === index + 1),
      stableRunIdentity: reconnected.runId === created.runId &&
        reconnected.normalizedSessionId === created.normalizedSessionId,
      stableProviderIdentity: JSON.stringify(reconnected.driverSession) === JSON.stringify(created.driverSession),
      replayAfterReconnect: afterReconnect.events.some((event) => event.eventType === "session.resumed"),
      goalCapabilityExplicit: typeof reconnected.capabilities?.goals === "boolean",
      credentialsAbsent: health.credentialsExposed === false &&
        secretValues.every((secret) => !serialized.includes(secret)),
      hostPathsAbsent: !serialized.includes("/srv/paperclip/home") &&
        !serialized.includes(".paperclip/instances/"),
    },
  });
  if (!Object.values(evidence.assertions).every(Boolean)) {
    throw new Error(`Live console evidence assertion failed: ${JSON.stringify(evidence.assertions)}`);
  }
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, assertions: evidence.assertions })}\n`);
} finally {
  await server.close();
}
