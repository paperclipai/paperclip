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

export const DELEGATE_PROFILE_VERSION = 2;
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

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?/.exec(value?.trim() ?? "");
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

function versionAtLeast(value, minimumMajor, minimumMinor = 0) {
  const parsed = parseVersion(value);
  if (!parsed) return false;
  return parsed.major > minimumMajor
    || (parsed.major === minimumMajor && parsed.minor >= minimumMinor);
}

function harnessLabel(harness) {
  if (harness === "codex") return "Codex";
  if (harness === "claude") return "Claude Code";
  return harness;
}

export function evaluateDelegatePrerequisites({
  nodeVersion,
  requirePnpm,
  pnpm,
  harnesses,
  requiredHarness = null,
}) {
  const issues = [];
  if (!versionAtLeast(nodeVersion, 24, 11)) {
    issues.push(`Node.js 24.11 or newer is required; found ${nodeVersion || "an unknown version"}.`);
  }

  if (requirePnpm) {
    if (!pnpm?.installed) {
      issues.push('pnpm 9 or newer is not installed. Run "corepack enable", then rerun ./setup-delegate.');
    } else if (!pnpm.version || !versionAtLeast(pnpm.version, 9)) {
      issues.push(
        `pnpm 9 or newer is required; found ${pnpm.version || "an unreadable version"}.`,
      );
    }
  }

  if (requiredHarness) {
    const selected = harnesses.find((row) => row.id === requiredHarness);
    const label = harnessLabel(requiredHarness);
    if (!selected) {
      issues.push(`${label} is required by the saved or selected delegate profile but is not installed.`);
    } else if (!selected.authenticated) {
      issues.push(`${label} is installed but not signed in.`);
    }
  } else if (!harnesses.some((row) => row.authenticated)) {
    if (harnesses.length === 0) {
      issues.push("Install and sign in to Codex or Claude Code.");
    } else {
      const labels = harnesses.map((row) => row.label).join(" and ");
      issues.push(`${labels} ${harnesses.length === 1 ? "is" : "are"} installed but not signed in.`);
    }
  }

  return issues;
}

function detectPnpm({ envPath = process.env.PATH ?? "" } = {}) {
  const path = executablePath("pnpm", envPath);
  if (!path) return { installed: false, version: null };
  const version = commandResult(path, ["--version"]);
  return {
    installed: true,
    version: version.ok ? version.stdout.split(/\s+/)[0] ?? null : null,
  };
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
  if (existingProfile && [1, DELEGATE_PROFILE_VERSION].includes(existingProfile.version) && !reconfigure) {
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
      chiefOfStaffAgentId: existingProfile.chiefOfStaffAgentId ?? null,
      generalistAgentId: existingProfile.generalistAgentId
        ?? (existingProfile.version === 1 ? existingProfile.agentId ?? null : null),
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
    chiefOfStaffAgentId: existingProfile?.chiefOfStaffAgentId ?? null,
    generalistAgentId: existingProfile?.generalistAgentId
      ?? (existingProfile?.version === 1 ? existingProfile.agentId ?? null : null),
  };
}

function chiefOfStaffInstructions(companyName) {
  return `You are Chief of Staff, the user's sole point of contact in ${companyName}.

When you wake up, follow the Paperclip skill. It contains the full heartbeat procedure.

You own every human-facing conversation, top-level task, decision, clarification, and review. The user should never need to coordinate with the Generalist directly.

## Role

Turn the user's approved outcomes into clear delegated work. Create focused child tasks for the Generalist, review the returned evidence and artifacts, request revisions when needed, and present one concise answer back to the user.

Do not forward raw worker chatter. Do not ask the user to manage the Generalist. Preserve context and accountability at the parent task.

## Delegation contract

- Read the top-level task, timing, source material, and prior conversation before delegating.
- Delegate concrete execution to the Generalist as a child task. Include the required artifact, acceptance criteria, source context, review time, and any approval boundaries.
- Keep the parent task assigned to yourself. Use a child task hold instead of polling the Generalist or its run.
- When the child completes, inspect the artifact and evidence yourself. Request a focused revision if it is not ready.
- Only you hand work to the user. Submit the reviewed parent result with --review-for-responsible-user and clearly state what the user should decide or check.

## Human interaction

- The Conference Room is your conversation with the user.
- Ask only questions that materially change the outcome. Use a human-only interaction and name the exact missing input.
- Translate internal execution state into Needs you, Ready to review, Working, Up next, or Done.
- Never expose model, heartbeat, run, workspace, or delegation internals unless the user asks.

## Working rules

Start actionable work in the same heartbeat. Leave durable progress with the next action. Use child issues for delegated work instead of polling agents, sessions, or processes. Mark blocked work with the unblock owner and action. Respect budget, pause/cancel, approval gates, company boundaries, and the user's explicit scope.

## Safety

- Never post externally, contact people, spend money, deploy, or delete data without explicit user approval.
- Never expose credentials or copy secrets into comments or artifacts.
- Timer heartbeats remain disabled; work only when assigned, commented to, or explicitly woken.

You must always update your top-level task with a comment before exiting a heartbeat.
`;
}

function generalistInstructions(companyName) {
  return `You are Generalist, the personal execution agent in ${companyName}.

When you wake up, follow the Paperclip skill. It contains the full heartbeat procedure.

You report to the Chief of Staff. Work only on delegated tasks assigned to you. Never ask the user to manage or coordinate your work directly.

## Role

Own concrete delegated knowledge-work deliverables end to end: research, synthesis, drafting, analysis, and preparation for the user's meetings and decisions.

Do not plan the user's day, create companies or agents, or decide what work should start. The Chief of Staff owns those decisions and the human relationship.

## Working rules

Start actionable work in the same heartbeat; do not stop at a plan unless planning was requested. Leave durable progress with a clear next action. Use child issues for long or parallel delegated work instead of polling. Mark blocked work with owner and action. Respect budget, pause/cancel, approval gates, and company boundaries.

- Read the assigned task, its timing, and prior comments before acting.
- Produce the smallest complete deliverable that satisfies the task.
- Add a progress comment whenever you materially advance or block the work.
- If input is missing, mark the task blocked and state exactly what the Chief of Staff must resolve.
- When the deliverable is complete, attach it, leave a concise evidence-backed handoff comment, and mark the delegated child task done. The Chief of Staff reviews your result and owns the parent task's human-facing review.

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

Before completing the child task, verify the artifact opens, the requested scope is covered, and the final comment explains what changed, what was checked, and what the Chief of Staff should review.

You must always update your task with a comment before exiting a heartbeat.
`;
}

function delegateAdapterConfig(desired) {
  // Delegate workers must call the local Paperclip control plane during every
  // task. Pin the CLI lane so localhost and the injected run JWT are available
  // to their shell tools instead of being trapped behind an ACP sandbox.
  const adapterConfig = { cwd: desired.workspaceCwd, engine: "cli" };
  if (desired.model) adapterConfig.model = desired.model;
  return adapterConfig;
}

function delegateRuntimeConfig() {
  return {
    heartbeat: {
      enabled: false,
      wakeOnDemand: true,
      skipTimerWhenNoActionableWork: true,
      cooldownSec: 10,
      maxConcurrentRuns: 1,
    },
  };
}

export function buildChiefOfStaffPayload(desired) {
  return {
    name: "Chief of Staff",
    role: "ceo",
    title: "Chief of Staff",
    icon: "crown",
    reportsTo: null,
    capabilities: "Owns the human relationship, delegates approved outcomes, reviews worker results, and presents final decisions and deliverables.",
    adapterType: desired.adapterType,
    adapterConfig: delegateAdapterConfig(desired),
    instructionsBundle: {
      entryFile: "AGENTS.md",
      files: { "AGENTS.md": chiefOfStaffInstructions(desired.workspaceName) },
    },
    runtimeConfig: delegateRuntimeConfig(),
    budgetMonthlyCents: 0,
    metadata: {
      delegateManaged: true,
      delegateRole: "chief_of_staff",
      delegateHumanFacing: true,
      delegateProfileVersion: DELEGATE_PROFILE_VERSION,
      instructionSource: "delegate_chief_of_staff",
    },
  };
}

export function buildGeneralistPayload(desired, chiefOfStaffAgentId) {
  return {
    name: "Generalist",
    role: "general",
    title: "Personal Generalist",
    icon: "sparkles",
    reportsTo: chiefOfStaffAgentId,
    capabilities: "Completes research, synthesis, drafting, analysis, and meeting-preparation child tasks delegated by the Chief of Staff.",
    adapterType: desired.adapterType,
    adapterConfig: delegateAdapterConfig(desired),
    instructionsBundle: {
      entryFile: "AGENTS.md",
      files: { "AGENTS.md": generalistInstructions(desired.workspaceName) },
    },
    runtimeConfig: delegateRuntimeConfig(),
    budgetMonthlyCents: 0,
    metadata: {
      delegateManaged: true,
      delegateRole: "generalist",
      delegateHumanFacing: false,
      delegateProfileVersion: DELEGATE_PROFILE_VERSION,
      instructionSource: "delegate_generalist",
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
    const error = new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${detail}`);
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
  await requestJson(apiUrl, "/instance/settings/experimental", {
    method: "PATCH",
    body: { enableConferenceRoomChat: true },
  });
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
    agentId: desired.chiefOfStaffAgentId ?? existingProfile?.chiefOfStaffAgentId ?? null,
    chiefOfStaffAgentId: desired.chiefOfStaffAgentId ?? existingProfile?.chiefOfStaffAgentId ?? null,
    generalistAgentId: desired.generalistAgentId
      ?? existingProfile?.generalistAgentId
      ?? (existingProfile?.version === 1 ? existingProfile.agentId ?? null : null),
    updatedAt: new Date().toISOString(),
    createdAt: existingProfile?.createdAt ?? new Date().toISOString(),
  };
  writeJsonAtomic(profilePath, partialProfile);

  let chiefOfStaffAgent = desired.chiefOfStaffAgentId
    ? await getIfPresent(apiUrl, `/agents/${encodeURIComponent(desired.chiefOfStaffAgentId)}`)
    : null;
  if (!chiefOfStaffAgent && existingProfile?.chiefOfStaffAgentId) {
    chiefOfStaffAgent = await getIfPresent(
      apiUrl,
      `/agents/${encodeURIComponent(existingProfile.chiefOfStaffAgentId)}`,
    );
  }
  if (chiefOfStaffAgent && chiefOfStaffAgent.companyId !== company.id) chiefOfStaffAgent = null;

  const chiefOfStaffPayload = buildChiefOfStaffPayload(desired);
  if (!chiefOfStaffAgent) {
    const agents = await requestJson(apiUrl, `/companies/${encodeURIComponent(company.id)}/agents`);
    const managedMatches = agents.filter((row) => (
      row.status !== "terminated"
      && row.metadata?.delegateManaged === true
      && row.metadata?.delegateRole === "chief_of_staff"
      && row.metadata?.delegateProfileVersion === DELEGATE_PROFILE_VERSION
    ));
    if (managedMatches.length > 1) {
      throw new Error(`Multiple managed Chief of Staff agents exist in ${company.name}`);
    }
    chiefOfStaffAgent = managedMatches[0] ?? null;
  }
  if (!chiefOfStaffAgent) {
    chiefOfStaffAgent = await requestJson(
      apiUrl,
      `/companies/${encodeURIComponent(company.id)}/agents`,
      { method: "POST", body: chiefOfStaffPayload },
    );
  } else {
    chiefOfStaffAgent = await requestJson(apiUrl, `/agents/${encodeURIComponent(chiefOfStaffAgent.id)}`, {
      method: "PATCH",
      body: { ...chiefOfStaffPayload, replaceAdapterConfig: true },
    });
  }

  const legacyGeneralistAgentId = existingProfile?.version === 1
    ? existingProfile.agentId ?? null
    : null;
  let generalistAgentId = desired.generalistAgentId
    ?? existingProfile?.generalistAgentId
    ?? legacyGeneralistAgentId;
  let generalistAgent = generalistAgentId
    ? await getIfPresent(apiUrl, `/agents/${encodeURIComponent(generalistAgentId)}`)
    : null;
  if (generalistAgent && generalistAgent.companyId !== company.id) generalistAgent = null;

  const generalistPayload = buildGeneralistPayload(desired, chiefOfStaffAgent.id);
  if (!generalistAgent) {
    const agents = await requestJson(apiUrl, `/companies/${encodeURIComponent(company.id)}/agents`);
    const managedMatches = agents.filter((row) => (
      row.status !== "terminated"
      && row.metadata?.delegateManaged === true
      && (
        row.metadata?.delegateRole === "generalist"
        || (!row.metadata?.delegateRole && row.name === "Generalist")
      )
    ));
    if (managedMatches.length > 1) {
      throw new Error(`Multiple managed Generalist agents exist in ${company.name}`);
    }
    generalistAgent = managedMatches[0] ?? null;
  }
  if (!generalistAgent) {
    generalistAgent = await requestJson(
      apiUrl,
      `/companies/${encodeURIComponent(company.id)}/agents`,
      { method: "POST", body: generalistPayload },
    );
  } else {
    generalistAgent = await requestJson(apiUrl, `/agents/${encodeURIComponent(generalistAgent.id)}`, {
      method: "PATCH",
      body: { ...generalistPayload, replaceAdapterConfig: true },
    });
  }

  const profile = {
    ...partialProfile,
    companyId: company.id,
    // `agentId` remains the compatibility pin consumed by setup-delegate's MCP
    // configuration. It now points at the sole human-facing Chief of Staff.
    agentId: chiefOfStaffAgent.id,
    chiefOfStaffAgentId: chiefOfStaffAgent.id,
    generalistAgentId: generalistAgent.id,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(profilePath, profile);
  return {
    profile,
    company,
    agent: chiefOfStaffAgent,
    chiefOfStaffAgent,
    generalistAgent,
  };
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

function preflightCommand() {
  const profilePath = process.env.PAPERCLIP_DELEGATE_PROFILE_PATH?.trim();
  const existingProfile = profilePath ? readJsonIfPresent(profilePath) : null;
  const reconfigure = process.env.PAPERCLIP_DELEGATE_RECONFIGURE === "true";
  const requiredHarness = !reconfigure
    && existingProfile
    && [1, DELEGATE_PROFILE_VERSION].includes(existingProfile.version)
    ? existingProfile.harness
    : process.env.PAPERCLIP_DELEGATE_HARNESS?.trim().toLowerCase() || null;
  const issues = evaluateDelegatePrerequisites({
    nodeVersion: process.versions.node,
    requirePnpm: process.env.PAPERCLIP_DELEGATE_SKIP_BUILD !== "true",
    pnpm: detectPnpm(),
    harnesses: detectHarnesses(),
    requiredHarness,
  });
  if (issues.length > 0) {
    throw new Error(
      `Delegate setup cannot continue. Fix these missing or incompatible prerequisites:\n${issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    );
  }
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
  output.write(
    `Provisioned ${result.company.name} with ${result.chiefOfStaffAgent.name} and ${result.generalistAgent.name}.\n`,
  );
}

function profileIdsCommand() {
  const profile = readJson(requiredEnv("PAPERCLIP_DELEGATE_PROFILE_PATH"));
  if (
    !profile.companyId
    || !profile.agentId
    || !profile.chiefOfStaffAgentId
    || !profile.generalistAgentId
  ) {
    throw new Error("Delegate profile is incomplete");
  }
  output.write(`${profile.companyId}\t${profile.agentId}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === "preflight") return preflightCommand();
  if (command === "ensure-instance") return ensureInstanceCommand();
  if (command === "prepare") return prepareCommand();
  if (command === "provision") return provisionCommand();
  if (command === "profile-ids") return profileIdsCommand();
  throw new Error(
    "Usage: delegate-bootstrap.mjs <preflight|ensure-instance|prepare|provision|profile-ids>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
