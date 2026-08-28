#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import {
  accessSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

export const DELEGATE_PROFILE_VERSION = 1;
export const DELEGATE_COMPANY_DESCRIPTION =
  "Personal Plan My Day workspace managed by setup-delegate.";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonIfPresent(path) {
  try {
    return readJson(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function firstAvailablePort(start, attempts = 100) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(`No available port found in ${start}-${start + attempts - 1}`);
}

function upsertEnvValue(path, key, value) {
  let lines = [];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  let found = false;
  const next = lines.map((line) => {
    if (line.split("=", 1)[0]?.trim() !== key) return line;
    found = true;
    return line.split("=").slice(1).join("=").trim() ? line : `${key}=${value}`;
  });
  if (!found) next.push(`${key}=${value}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${next.join("\n")}\n`, { mode: 0o600 });
}

export async function ensureInstanceFiles({ configPath, envPath, instanceDir, apiUrl }) {
  let config = readJsonIfPresent(configPath);
  if (!config) {
    let serverPort = null;
    if (apiUrl) {
      const parsed = new URL(apiUrl);
      serverPort = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
    }
    serverPort ??= await firstAvailablePort(3100);
    const databasePort = await firstAvailablePort(54329);
    const now = new Date().toISOString();
    config = {
      $meta: { version: 1, updatedAt: now, source: "onboard" },
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: join(instanceDir, "db"),
        embeddedPostgresPort: databasePort,
        backup: {
          enabled: false,
          intervalMinutes: 60,
          retentionDays: 30,
          dir: join(instanceDir, "data", "backups"),
        },
      },
      logging: { mode: "file", logDir: join(instanceDir, "logs") },
      server: {
        deploymentMode: "local_trusted",
        exposure: "private",
        bind: "loopback",
        host: "127.0.0.1",
        port: serverPort,
        allowedHostnames: [],
        serveUi: true,
      },
      telemetry: { enabled: true },
      updates: { checkEnabled: true },
      auth: { baseUrlMode: "auto", disableSignUp: false },
      storage: {
        provider: "local_disk",
        localDisk: { baseDir: join(instanceDir, "data", "storage") },
        s3: {
          bucket: "paperclip",
          region: "us-east-1",
          prefix: "",
          forcePathStyle: false,
        },
      },
      secrets: {
        provider: "local_encrypted",
        strictMode: false,
        localEncrypted: { keyFilePath: join(instanceDir, "secrets", "master.key") },
      },
    };
    writeJsonAtomic(configPath, config);
  }
  upsertEnvValue(envPath, "PAPERCLIP_AGENT_JWT_SECRET", randomBytes(32).toString("hex"));
  return config;
}

function executablePath(command, envPath = process.env.PATH ?? "") {
  if (command.includes("/")) {
    try {
      accessSync(command, fsConstants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const directory of envPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function commandResult(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 8_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

export function detectHarnesses({ envPath = process.env.PATH ?? "" } = {}) {
  const codexPath = executablePath("codex", envPath);
  const claudePath = executablePath("claude", envPath);
  const rows = [];
  if (codexPath) {
    const auth = commandResult(codexPath, ["login", "status"]);
    rows.push({
      id: "codex",
      label: "Codex",
      command: codexPath,
      authenticated: auth.ok && /logged in/i.test(`${auth.stdout}\n${auth.stderr}`),
    });
  }
  if (claudePath) {
    const auth = commandResult(claudePath, ["auth", "status", "--json"]);
    let authenticated = false;
    try {
      authenticated = auth.ok && JSON.parse(auth.stdout).loggedIn === true;
    } catch {
      authenticated = false;
    }
    rows.push({
      id: "claude",
      label: "Claude Code",
      command: claudePath,
      authenticated,
    });
  }
  return rows;
}

function defaultWorkspaceName() {
  const username = userInfo().username || "Personal";
  const display = username.charAt(0).toUpperCase() + username.slice(1);
  return `${display}'s Workspace`;
}

async function ask(question, fallback, readline) {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = (await readline.question(`${question}${suffix}: `)).trim();
  return value || fallback;
}

export async function collectDesiredProfile({
  existingProfile,
  instanceDir,
  env = process.env,
  harnesses = detectHarnesses(),
  readline,
}) {
  const reconfigure = env.PAPERCLIP_DELEGATE_RECONFIGURE === "true";
  if (existingProfile && existingProfile.version === DELEGATE_PROFILE_VERSION && !reconfigure) {
    const existingHarness = harnesses.find((row) => row.id === existingProfile.harness);
    if (!existingHarness?.authenticated) {
      throw new Error(
        `${existingProfile.harness} is no longer installed and signed in. Fix it or rerun with PAPERCLIP_DELEGATE_RECONFIGURE=true.`,
      );
    }
    return {
      harness: existingProfile.harness,
      adapterType: existingProfile.adapterType,
      model: existingProfile.model ?? null,
      workspaceName: existingProfile.workspaceName,
      workspaceCwd: existingProfile.workspaceCwd,
      companyId: existingProfile.companyId ?? null,
      agentId: existingProfile.agentId ?? null,
    };
  }

  const authenticated = harnesses.filter((row) => row.authenticated);
  if (authenticated.length === 0) {
    const installed = harnesses.map((row) => row.label).join(" and ");
    throw new Error(
      installed
        ? `${installed} is installed but not signed in. Sign in, then rerun ./setup-delegate.`
        : "Install and sign in to Claude Code or Codex, then rerun ./setup-delegate.",
    );
  }

  let harness = env.PAPERCLIP_DELEGATE_HARNESS?.trim().toLowerCase() ?? "";
  if (harness && !authenticated.some((row) => row.id === harness)) {
    throw new Error(`PAPERCLIP_DELEGATE_HARNESS=${harness} is not installed and signed in`);
  }
  if (!harness) {
    if (!readline && !input.isTTY) {
      throw new Error("Set PAPERCLIP_DELEGATE_HARNESS for non-interactive setup");
    }
    const prompt = readline ?? createInterface({ input, output });
    const ownsPrompt = !readline;
    output.write("\nWhich harness should execute delegated work?\n");
    authenticated.forEach((row, index) => output.write(`  ${index + 1}) ${row.label}\n`));
    const choice = await ask("Choose", "1", prompt);
    const selected = authenticated[Number(choice) - 1]
      ?? authenticated.find((row) => row.id === choice.toLowerCase());
    if (!selected) throw new Error(`Invalid harness selection: ${choice}`);
    harness = selected.id;
    if (ownsPrompt) prompt.close();
  }

  const selectedHarness = authenticated.find((row) => row.id === harness);
  if (!selectedHarness) throw new Error(`Harness ${harness} is not available`);

  const adapterType = harness === "codex" ? "codex_local" : "claude_local";
  let model = env.PAPERCLIP_DELEGATE_MODEL;
  let workspaceName = env.PAPERCLIP_DELEGATE_WORKSPACE_NAME;
  const needsPrompt = model === undefined || workspaceName === undefined;
  if (needsPrompt) {
    if (!readline && !input.isTTY) {
      throw new Error(
        "Set PAPERCLIP_DELEGATE_MODEL and PAPERCLIP_DELEGATE_WORKSPACE_NAME for non-interactive setup",
      );
    }
    const prompt = readline ?? createInterface({ input, output });
    const ownsPrompt = !readline;
    if (model === undefined) {
      model = await ask(
        `Model ID for ${selectedHarness.label} (leave blank to use its current default)`,
        "",
        prompt,
      );
    }
    if (workspaceName === undefined) {
      workspaceName = await ask("Personal workspace name", defaultWorkspaceName(), prompt);
    }
    if (ownsPrompt) prompt.close();
  }

  const cleanWorkspaceName = workspaceName?.trim();
  if (!cleanWorkspaceName) throw new Error("Personal workspace name cannot be empty");
  const workspaceCwd = env.PAPERCLIP_DELEGATE_WORKSPACE_CWD?.trim()
    || existingProfile?.workspaceCwd
    || join(instanceDir, "delegate-workspace");

  return {
    harness,
    adapterType,
    model: model?.trim() || null,
    workspaceName: cleanWorkspaceName,
    workspaceCwd,
    companyId: existingProfile?.companyId ?? null,
    agentId: existingProfile?.agentId ?? null,
  };
}

function generalistInstructions(companyName) {
  return `You are Generalist, the personal execution agent in ${companyName}.

When you wake up, follow the Paperclip skill. It contains the full heartbeat procedure.

You report to the user through the Paperclip board. Work only on tasks assigned to you.

## Role

Own concrete delegated knowledge-work deliverables end to end: research, synthesis, drafting, analysis, and preparation for the user's meetings and decisions.

Do not plan the user's day, create companies or agents, or decide what work should start. The user and their planning conversation own those decisions.

## Working rules

Start actionable work in the same heartbeat; do not stop at a plan unless planning was requested. Leave durable progress with a clear next action. Use child issues for long or parallel delegated work instead of polling. Mark blocked work with owner and action. Respect budget, pause/cancel, approval gates, and company boundaries.

- Read the assigned task, its timing, and prior comments before acting.
- Produce the smallest complete deliverable that satisfies the task.
- Add a progress comment whenever you materially advance or block the work.
- If input is missing, mark the task blocked and state exactly what the user must provide.
- Submit completed work for review by moving the task to in_review; never accept your own work.

## Decision lenses

- Deadline pull-forward: protect the user's review window, not only the final due time.
- Reviewability: make the result easy to judge quickly.
- Source fidelity: distinguish evidence, inference, and recommendation.
- Smallest sufficient artifact: avoid unnecessary scope and ceremony.
- Approval boundary: do not take external or destructive action without explicit approval.

## Output bar

A good result is usable as-is, names important assumptions, links or attaches its evidence, and ends with the decisions or next actions the user needs.

A status update without the requested artifact is not a completed task.

## Safety and permissions

- Never post externally, contact people, spend money, deploy, or delete data without explicit approval.
- Never expose credentials or copy secrets into task comments or artifacts.
- Stay inside the assigned company, task, and available workspace.
- Timer heartbeats remain disabled; work only when assigned or explicitly woken.

## Done

Before requesting review, verify the artifact opens, the requested scope is covered, and the final comment explains what changed, what was checked, and what the user should review.

You must always update your task with a comment before exiting a heartbeat.
`;
}

export function buildAgentPayload(desired) {
  const adapterConfig = { cwd: desired.workspaceCwd };
  if (desired.model) adapterConfig.model = desired.model;
  return {
    name: "Generalist",
    role: "general",
    title: "Personal Generalist",
    icon: "sparkles",
    reportsTo: null,
    capabilities: "Completes assigned research, synthesis, drafting, analysis, and meeting-preparation deliverables for the user.",
    adapterType: desired.adapterType,
    adapterConfig,
    instructionsBundle: {
      entryFile: "AGENTS.md",
      files: { "AGENTS.md": generalistInstructions(desired.workspaceName) },
    },
    runtimeConfig: {
      heartbeat: {
        enabled: false,
        wakeOnDemand: true,
        skipTimerWhenNoActionableWork: true,
        cooldownSec: 10,
        maxConcurrentRuns: 1,
      },
    },
    budgetMonthlyCents: 0,
    metadata: {
      delegateManaged: true,
      delegateProfileVersion: DELEGATE_PROFILE_VERSION,
      instructionSource: "generic_fallback",
    },
  };
}

function normalizeApiUrl(value) {
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

async function requestJson(apiUrl, path, options = {}) {
  const response = await fetch(`${normalizeApiUrl(apiUrl)}/api${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail = body && typeof body === "object" && typeof body.error === "string"
      ? body.error
      : String(body ?? response.statusText);
    const error = new Error(`${response.status} ${detail}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function getIfPresent(apiUrl, path) {
  try {
    return await requestJson(apiUrl, path);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export async function waitForPaperclip(apiUrl, { attempts = 80, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const health = await requestJson(apiUrl, "/health");
      if (health?.status === "ok") return health;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Paperclip did not become healthy at ${apiUrl}`);
}

export async function provisionDelegateProfile({
  apiUrl,
  desired,
  existingProfile,
  profilePath,
}) {
  await waitForPaperclip(apiUrl);
  mkdirSync(desired.workspaceCwd, { recursive: true });

  let company = desired.companyId
    ? await getIfPresent(apiUrl, `/companies/${encodeURIComponent(desired.companyId)}`)
    : null;
  if (!company && existingProfile?.companyId) {
    company = await getIfPresent(apiUrl, `/companies/${encodeURIComponent(existingProfile.companyId)}`);
  }
  if (!company) {
    const companies = await requestJson(apiUrl, "/companies");
    const managedMatches = companies.filter((row) => (
      row.name === desired.workspaceName
      && row.description === DELEGATE_COMPANY_DESCRIPTION
      && row.status !== "archived"
    ));
    if (managedMatches.length > 1) {
      throw new Error(`Multiple managed personal companies are named ${desired.workspaceName}`);
    }
    company = managedMatches[0] ?? await requestJson(apiUrl, "/companies", {
      method: "POST",
      body: {
        name: desired.workspaceName,
        description: DELEGATE_COMPANY_DESCRIPTION,
        budgetMonthlyCents: 0,
      },
    });
  } else if (company.name !== desired.workspaceName) {
    company = await requestJson(apiUrl, `/companies/${encodeURIComponent(company.id)}`, {
      method: "PATCH",
      body: { name: desired.workspaceName },
    });
  }

  const partialProfile = {
    version: DELEGATE_PROFILE_VERSION,
    ...desired,
    apiUrl: normalizeApiUrl(apiUrl),
    companyId: company.id,
    agentId: null,
    updatedAt: new Date().toISOString(),
    createdAt: existingProfile?.createdAt ?? new Date().toISOString(),
  };
  writeJsonAtomic(profilePath, partialProfile);

  let agent = desired.agentId
    ? await getIfPresent(apiUrl, `/agents/${encodeURIComponent(desired.agentId)}`)
    : null;
  if (!agent && existingProfile?.agentId) {
    agent = await getIfPresent(apiUrl, `/agents/${encodeURIComponent(existingProfile.agentId)}`);
  }
  if (agent && agent.companyId !== company.id) agent = null;

  const agentPayload = buildAgentPayload(desired);
  if (!agent) {
    const agents = await requestJson(apiUrl, `/companies/${encodeURIComponent(company.id)}/agents`);
    const managedMatches = agents.filter((row) => (
      row.status !== "terminated"
      && row.metadata?.delegateManaged === true
      && row.metadata?.delegateProfileVersion === DELEGATE_PROFILE_VERSION
    ));
    if (managedMatches.length > 1) {
      throw new Error(`Multiple managed Generalist agents exist in ${company.name}`);
    }
    agent = managedMatches[0] ?? await requestJson(
      apiUrl,
      `/companies/${encodeURIComponent(company.id)}/agents`,
      { method: "POST", body: agentPayload },
    );
  } else {
    agent = await requestJson(apiUrl, `/agents/${encodeURIComponent(agent.id)}`, {
      method: "PATCH",
      body: { ...agentPayload, replaceAdapterConfig: true },
    });
  }

  const profile = {
    ...partialProfile,
    companyId: company.id,
    agentId: agent.id,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(profilePath, profile);
  return { profile, company, agent };
}

async function prepareCommand() {
  const profilePath = requiredEnv("PAPERCLIP_DELEGATE_PROFILE_PATH");
  const desiredPath = requiredEnv("PAPERCLIP_DELEGATE_DESIRED_PATH");
  const instanceDir = requiredEnv("PAPERCLIP_DELEGATE_INSTANCE_DIR");
  const existingProfile = readJsonIfPresent(profilePath);
  const desired = await collectDesiredProfile({ existingProfile, instanceDir });
  writeJsonAtomic(desiredPath, desired);
  output.write(`Prepared ${desired.workspaceName} with ${desired.harness}${desired.model ? ` (${desired.model})` : " (default model)"}.\n`);
}

async function ensureInstanceCommand() {
  const configPath = requiredEnv("PAPERCLIP_CONFIG");
  const envPath = requiredEnv("PAPERCLIP_DELEGATE_ENV_PATH");
  const instanceDir = requiredEnv("PAPERCLIP_DELEGATE_INSTANCE_DIR");
  const config = await ensureInstanceFiles({
    configPath,
    envPath,
    instanceDir,
    apiUrl: process.env.PAPERCLIP_API_URL?.trim() || null,
  });
  output.write(`Paperclip instance configured on port ${config.server.port}.\n`);
}

async function provisionCommand() {
  const profilePath = requiredEnv("PAPERCLIP_DELEGATE_PROFILE_PATH");
  const desiredPath = requiredEnv("PAPERCLIP_DELEGATE_DESIRED_PATH");
  const apiUrl = requiredEnv("PAPERCLIP_API_URL");
  const existingProfile = readJsonIfPresent(profilePath);
  const desired = readJson(desiredPath);
  const result = await provisionDelegateProfile({ apiUrl, desired, existingProfile, profilePath });
  output.write(`Provisioned ${result.company.name} with ${result.agent.name}.\n`);
}

function profileIdsCommand() {
  const profile = readJson(requiredEnv("PAPERCLIP_DELEGATE_PROFILE_PATH"));
  if (!profile.companyId || !profile.agentId) throw new Error("Delegate profile is incomplete");
  output.write(`${profile.companyId}\t${profile.agentId}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === "ensure-instance") return ensureInstanceCommand();
  if (command === "prepare") return prepareCommand();
  if (command === "provision") return provisionCommand();
  if (command === "profile-ids") return profileIdsCommand();
  throw new Error("Usage: delegate-bootstrap.mjs <ensure-instance|prepare|provision|profile-ids>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
