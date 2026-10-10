import { Command } from "commander";

import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./client/common.js";

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
export const CLAUDE_MANAGED_BETA_VERSION = "managed-agents-2026-04-01" as const;
export const CLAUDE_MANAGED_QUALIFIED_MODEL = "claude-sonnet-5" as const;
export const CLAUDE_MANAGED_SYSTEM_PROMPT =
  "You are a Paperclip remote agent. Follow the current user turn and use only the custom tools supplied for that session. Paperclip tool authority, completion, blocking, review, and yielding are enforced by the runner. Never request or infer a Paperclip endpoint or credential.";

export interface ManagedAgentSetupOptions extends BaseClientOptions {
  companyId?: string;
  profileKey: string;
  displayName: string;
  apiKeySecretId: string;
  model: string;
  maxSessionListCostUsd: string;
  agentId?: string;
  agentVersion?: string;
  environmentId?: string;
  probe?: boolean;
  acknowledgeRetention?: boolean;
}

interface RemoteResource {
  id?: string;
  [key: string]: unknown;
}

interface ValidatedSetup {
  anthropicApiKey: string;
  profileKey: string;
  displayName: string;
  apiKeySecretId: string;
  model: string;
  agentId?: string;
  agentVersion?: string;
  environmentId?: string;
  defaultMaxListCostUsd: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function validateManagedAgentSetup(
  options: ManagedAgentSetupOptions,
  env: NodeJS.ProcessEnv = process.env,
): ValidatedSetup {
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required in the CLI process environment");
  }
  if (!options.acknowledgeRetention) {
    throw new Error(
      "Pass --acknowledge-retention to enable the stateful beta Managed Agents service",
    );
  }

  const profileKey = required(options.profileKey, "--profile-key");
  const displayName = required(options.displayName, "--display-name");
  const apiKeySecretId = required(options.apiKeySecretId, "--api-key-secret-id");
  const model = required(options.model, "--model");
  if (model !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
    throw new Error(
      `--model must be the qualified Managed Agents model ${CLAUDE_MANAGED_QUALIFIED_MODEL}`,
    );
  }
  if (!UUID_RE.test(apiKeySecretId)) {
    throw new Error("--api-key-secret-id must be a UUID");
  }

  const defaultMaxListCostUsd = Number(options.maxSessionListCostUsd);
  const cents = Math.round(defaultMaxListCostUsd * 100);
  if (
    !Number.isFinite(defaultMaxListCostUsd)
    || defaultMaxListCostUsd <= 0
    || !Number.isSafeInteger(cents)
    || cents <= 0
  ) {
    throw new Error("--max-session-list-cost-usd must resolve to at least one cent");
  }

  return {
    anthropicApiKey,
    profileKey,
    displayName,
    apiKeySecretId,
    model,
    agentId: options.agentId?.trim() || undefined,
    agentVersion: options.agentVersion?.trim() || undefined,
    environmentId: options.environmentId?.trim() || undefined,
    defaultMaxListCostUsd,
  };
}

async function anthropicRequest(
  key: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${ANTHROPIC_ORIGIN}${path}`, {
    method,
    headers: {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": CLAUDE_MANAGED_BETA_VERSION,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Anthropic Managed Agents request failed with HTTP ${response.status}`);
  }
  if (response.status === 204) return {};
  return record(await response.json());
}

async function listAll(key: string, path: string): Promise<RemoteResource[]> {
  const rows: RemoteResource[] = [];
  let page: string | null = null;
  do {
    const suffix = page ? `${path.includes("?") ? "&" : "?"}page=${encodeURIComponent(page)}` : "";
    const response = await anthropicRequest(key, "GET", `${path}${suffix}`);
    for (const value of Array.isArray(response.data) ? response.data : []) {
      rows.push(record(value) as RemoteResource);
    }
    page = typeof response.next_page === "string" && response.next_page
      ? response.next_page
      : null;
  } while (page);
  return rows;
}

function resourceByProfile(
  resources: RemoteResource[],
  profileKey: string,
  resourceLabel: string,
): RemoteResource | null {
  const matches = resources.filter(
    (resource) =>
      typeof resource.id === "string"
      && record(resource.metadata).paperclip_profile === profileKey,
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple Anthropic ${resourceLabel} resources use Paperclip profile ${profileKey}; pass an explicit resource ID`,
    );
  }
  return matches[0] ?? null;
}

export function assertSafeManagedEnvironment(environment: Record<string, unknown>): void {
  const config = record(environment.config);
  const networking = record(config.networking);
  const packages = record(config.packages);
  const installed = Object.entries(packages)
    .filter(([key]) => key !== "type")
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value !== undefined && value !== null);
  if (
    environment.archived_at !== null
    || config.type !== "cloud"
    || networking.type !== "limited"
    || networking.allow_mcp_servers !== false
    || networking.allow_package_managers !== false
    || !Array.isArray(networking.allowed_hosts)
    || networking.allowed_hosts.length > 0
    || installed.length > 0
  ) {
    throw new Error(
      "Existing Anthropic Environment does not match Paperclip's no-network, no-package profile",
    );
  }
}

export function assertSafeManagedAgent(agent: Record<string, unknown>): void {
  const model = typeof agent.model === "string" ? agent.model : record(agent.model).id;
  if (
    agent.archived_at !== null
    || agent.system !== CLAUDE_MANAGED_SYSTEM_PROMPT
    || typeof model !== "string"
    || !model
    || !Array.isArray(agent.tools)
    || agent.tools.length > 0
    || !Array.isArray(agent.mcp_servers)
    || agent.mcp_servers.length > 0
    || !Array.isArray(agent.skills)
    || agent.skills.length > 0
    || agent.multiagent != null
  ) {
    throw new Error(
      "Existing Anthropic Agent enables or omits the locked tools, MCP, skills, or multi-agent profile",
    );
  }
}

async function resolveEnvironment(
  key: string,
  options: ManagedAgentSetupOptions,
): Promise<Record<string, unknown>> {
  if (options.environmentId) {
    const environment = await anthropicRequest(
      key,
      "GET",
      `/v1/environments/${encodeURIComponent(options.environmentId)}`,
    );
    assertSafeManagedEnvironment(environment);
    return environment;
  }

  const existing = resourceByProfile(
    await listAll(key, "/v1/environments"),
    options.profileKey,
    "Environment",
  );
  if (existing) {
    assertSafeManagedEnvironment(existing);
    return existing;
  }
  if (options.probe) throw new Error("Probe found no matching Anthropic Environment");

  const environment = await anthropicRequest(key, "POST", "/v1/environments", {
    name: `Paperclip · ${options.displayName}`,
    description: "Paperclip remote-agent environment: no network or added packages.",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allow_mcp_servers: false,
        allow_package_managers: false,
        allowed_hosts: [],
      },
      packages: {
        apt: [],
        cargo: [],
        gem: [],
        go: [],
        npm: [],
        pip: [],
      },
    },
    metadata: { paperclip_profile: options.profileKey },
  });
  assertSafeManagedEnvironment(environment);
  return environment;
}

async function resolveAgent(
  key: string,
  options: ManagedAgentSetupOptions,
): Promise<Record<string, unknown>> {
  if (options.agentId) {
    const agent = await anthropicRequest(
      key,
      "GET",
      `/v1/agents/${encodeURIComponent(options.agentId)}`,
    );
    assertSafeManagedAgent(agent);
    assertManagedAgentModel(agent, options.model);
    return agent;
  }

  const existing = resourceByProfile(
    await listAll(key, "/v1/agents"),
    options.profileKey,
    "Agent",
  );
  if (existing) {
    assertSafeManagedAgent(existing);
    assertManagedAgentModel(existing, options.model);
    return existing;
  }
  if (options.probe) throw new Error("Probe found no matching Anthropic Agent");

  const agent = await anthropicRequest(key, "POST", "/v1/agents", {
    name: `Paperclip · ${options.displayName}`,
    description: "Versioned Paperclip remote agent; runnerd supplies session tools.",
    model: options.model,
    system: CLAUDE_MANAGED_SYSTEM_PROMPT,
    tools: [],
    mcp_servers: [],
    skills: [],
    metadata: { paperclip_profile: options.profileKey },
  });
  assertSafeManagedAgent(agent);
  assertManagedAgentModel(agent, options.model);
  return agent;
}

function assertManagedAgentModel(agent: Record<string, unknown>, expectedModel: string): void {
  const model = typeof agent.model === "string" ? agent.model : record(agent.model).id;
  if (model !== expectedModel) {
    throw new Error(
      `Existing Anthropic Agent model does not match the requested pinned model ${expectedModel}`,
    );
  }
}

export async function setupManagedAgent(options: ManagedAgentSetupOptions): Promise<void> {
  const validated = validateManagedAgentSetup(options);
  const normalizedOptions: ManagedAgentSetupOptions = {
    ...options,
    profileKey: validated.profileKey,
    displayName: validated.displayName,
    apiKeySecretId: validated.apiKeySecretId,
    model: validated.model,
    agentId: validated.agentId,
    agentVersion: validated.agentVersion,
    environmentId: validated.environmentId,
  };
  const [environment, agent] = await Promise.all([
    resolveEnvironment(validated.anthropicApiKey, normalizedOptions),
    resolveAgent(validated.anthropicApiKey, normalizedOptions),
  ]);
  const agentId = String(agent.id ?? "");
  const environmentId = String(environment.id ?? "");
  if (!agentId || !environmentId) {
    throw new Error("Anthropic did not return usable Agent and Environment identities");
  }

  const versions = await listAll(
    validated.anthropicApiKey,
    `/v1/agents/${encodeURIComponent(agentId)}/versions`,
  );
  const version = normalizedOptions.agentVersion
    ?? String(agent.version ?? versions.at(-1)?.version ?? "");
  const pinnedAgent = version
    ? versions.find((entry) => String(entry.version) === version)
    : undefined;
  if (!version || !pinnedAgent) {
    throw new Error("Anthropic did not return a usable pinned Agent version");
  }
  if (String(pinnedAgent.id ?? "") !== agentId) {
    throw new Error("Anthropic pinned Agent version identity does not match the selected Agent");
  }
  assertSafeManagedAgent(pinnedAgent);
  assertManagedAgentModel(pinnedAgent, normalizedOptions.model);

  const qualification = {
    probedAt: new Date().toISOString(),
    betaVersion: CLAUDE_MANAGED_BETA_VERSION,
    environmentPolicy: "limited_no_hosts_no_packages",
    agentCapabilities: "no_tools_no_mcp_no_skills_no_multiagent",
  };
  const profile = {
    profileKey: normalizedOptions.profileKey,
    displayName: normalizedOptions.displayName,
    anthropicAgentId: agentId,
    agentVersion: version,
    environmentId,
    defaultModel: normalizedOptions.model,
    defaultMaxListCostUsd: validated.defaultMaxListCostUsd,
    apiKeySecretId: normalizedOptions.apiKeySecretId,
    enabled: !options.probe,
    retentionAcknowledged: true,
    qualification,
  };

  if (options.probe) {
    printOutput({ mode: "probe", qualified: true, profile }, { json: options.json });
    return;
  }

  const context = resolveCommandContext(options, { requireCompany: true });
  const stored = await context.api.post(
    apiPath`/api/companies/${context.companyId}/managed-agent-profiles`,
    profile,
  );
  printOutput(stored, { json: context.json });
}

export function registerManagedAgentCommands(program: Command): void {
  const command = program
    .command("managed-agent")
    .description("Provision and qualify remote managed-agent providers");
  addCommonClientOptions(
    command
      .command("setup")
      .description(
        "Create or adopt a locked-down Anthropic Agent and Environment, then store a company profile",
      )
      .requiredOption("--profile-key <key>", "Stable company profile key")
      .requiredOption("--display-name <name>", "Profile display name")
      .requiredOption(
        "--api-key-secret-id <id>",
        "Existing company secret containing ANTHROPIC_API_KEY",
      )
      .option("--model <id>", "Pinned Claude model", CLAUDE_MANAGED_QUALIFIED_MODEL)
      .option(
        "--max-session-list-cost-usd <usd>",
        "Default hard session ceiling",
        "1.00",
      )
      .option("--agent-id <id>", "Adopt an existing Anthropic Agent")
      .option("--agent-version <version>", "Pin an existing Agent version")
      .option("--environment-id <id>", "Adopt an existing Anthropic Environment")
      .option("--probe", "Read-only qualification; create or persist nothing", false)
      .option(
        "--acknowledge-retention",
        "Acknowledge beta retention and non-ZDR/non-HIPAA status",
        false,
      )
      .action(async (options: ManagedAgentSetupOptions) => {
        try {
          await setupManagedAgent(options);
        } catch (error) {
          handleCommandError(error);
        }
      }),
    { includeCompany: true },
  );
}
