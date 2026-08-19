import { Command } from "commander";
import {
  BOARD_API_KEY_SCOPE_PRESETS,
  boardApiKeyScopeConfigSchema,
  createAgentKeySchema,
  createBoardApiKeySchema,
  type Agent,
  type BoardApiKeyScopeConfig,
  type BoardApiKeyScopePreset,
  type BoardApiKeyStatus,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AgentTokenOptions extends BaseClientOptions {
  companyId?: string;
  agent?: string;
  name?: string;
}

interface BoardTokenOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  expiresAt?: string;
  ttlDays?: string;
  neverExpires?: boolean;
  scopePreset?: string;
  scopeCompanyId?: string[];
  scopeConfigJson?: string;
}

interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

interface AgentKeyRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

interface CreatedBoardKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

interface BoardKeyRow {
  id: string;
  name: string;
  tokenPrefix: string | null;
  scopeConfig: BoardApiKeyScopeConfig | null;
  legacyUnrestricted: boolean;
  status: BoardApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

export function registerTokenCommands(program: Command): void {
  const token = program.command("token").description("Manage Paperclip API tokens");
  const agent = token.command("agent").description("Manage agent API keys");

  addCommonClientOptions(
    agent
      .command("create")
      .description("Create an agent API key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--agent <agent>", "Agent ID, shortname, or unambiguous name")
      .option("--name <name>", "API key label", "cli-agent")
      .action(async (opts: AgentTokenOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx.api, ctx.companyId ?? "", opts.agent ?? "");
          const payload = createAgentKeySchema.parse({ name: opts.name });
          const key = await ctx.api.post<CreatedAgentKey>(apiPath`/api/agents/${agentRow.id}/keys`, payload);
          if (!key) throw new Error("Failed to create agent API key");
          printOutput(
            {
              agentId: agentRow.id,
              agentName: agentRow.name,
              companyId: agentRow.companyId,
              key,
            },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("list")
      .description("List agent API keys")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--agent <agent>", "Agent ID, shortname, or unambiguous name")
      .action(async (opts: AgentTokenOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx.api, ctx.companyId ?? "", opts.agent ?? "");
          const keys = (await ctx.api.get<AgentKeyRow[]>(apiPath`/api/agents/${agentRow.id}/keys`)) ?? [];
          if (ctx.json) {
            printOutput({ agentId: agentRow.id, companyId: agentRow.companyId, keys }, { json: true });
            return;
          }
          for (const key of keys) {
            console.log(formatInlineRecord({ id: key.id, name: key.name, createdAt: key.createdAt, revokedAt: key.revokedAt ?? null }));
          }
          if (keys.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("revoke")
      .description("Revoke an agent API key")
      .argument("<keyId>", "Agent API key ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--agent <agent>", "Agent ID, shortname, or unambiguous name")
      .action(async (keyId: string, opts: AgentTokenOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx.api, ctx.companyId ?? "", opts.agent ?? "");
          const result = await ctx.api.delete<{ ok: true; keyId?: string }>(apiPath`/api/agents/${agentRow.id}/keys/${keyId}`);
          printOutput({ ok: true, agentId: agentRow.id, companyId: agentRow.companyId, ...(result ?? {}) }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const board = token.command("board").description("Manage board API keys");

  addCommonClientOptions(
    board
      .command("create")
      .description("Create a named board API key")
      .requiredOption("-C, --company-id <id>", "Company ID to pin in the key scope")
      .option("--name <name>", "API key label", "cli-board")
      .option("--expires-at <iso8601>", "Expiration timestamp")
      .option("--ttl-days <days>", "Expiration in days from now")
      .option("--never-expires", "Create a non-expiring key")
      .option(
        "--scope-preset <preset>",
        "Scope preset (read_only|company_automation|full_instance_admin)",
      )
      .option(
        "--scope-company-id <id>",
        "Additional company ID to pin; may be repeated",
        collectOptionValue,
        [] as string[],
      )
      .option(
        "--scope-config-json <json>",
        "Custom strict BoardApiKeyScopeConfig JSON (cannot be combined with preset/additional company flags)",
      )
      .action(async (opts: BoardTokenOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const expiresAt = resolveBoardKeyExpiresAt(opts);
          const scopeConfig = resolveBoardKeyScopeConfig(opts, ctx.companyId as string);
          const payload = createBoardApiKeySchema.parse({
            name: opts.name,
            expiresAt,
            scopeConfig,
          });
          const key = await ctx.api.post<CreatedBoardKey>("/api/board-api-keys", payload);
          if (!key) throw new Error("Failed to create board API key");
          printOutput({ key }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    board
      .command("list")
      .description("List board API keys for the current board user")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const keys = (await ctx.api.get<BoardKeyRow[]>("/api/board-api-keys")) ?? [];
          if (ctx.json) {
            printOutput(keys, { json: true });
            return;
          }
          for (const key of keys) {
            console.log(formatInlineRecord({
              id: key.id,
              name: key.name,
              tokenPrefix: key.tokenPrefix,
              status: key.status,
              legacyUnrestricted: key.legacyUnrestricted,
              scope: summarizeBoardKeyScope(key.scopeConfig),
              createdAt: key.createdAt,
              lastUsedAt: key.lastUsedAt,
              expiresAt: key.expiresAt,
              revokedAt: key.revokedAt,
            }));
          }
          if (keys.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    board
      .command("revoke")
      .description("Revoke a board API key")
      .argument("<keyId>", "Board API key ID")
      .action(async (keyId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete<{ ok: true; keyId: string }>(apiPath`/api/board-api-keys/${keyId}`);
          printOutput(result ?? { ok: true, keyId }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function resolveAgent(api: { get<T>(path: string): Promise<T | null> }, companyId: string, agentRef: string): Promise<Agent> {
  const trimmed = agentRef.trim();
  if (!trimmed) throw new Error("Agent reference is required");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    const agent = await api.get<Agent>(apiPath`/api/agents/${trimmed}`);
    if (!agent || agent.companyId !== companyId) throw new Error(`Agent not found: ${agentRef}`);
    return agent;
  }
  const query = new URLSearchParams({ companyId });
  const agent = await api.get<Agent>(`${apiPath`/api/agents/${trimmed}`}?${query.toString()}`);
  if (!agent || agent.companyId !== companyId) throw new Error(`Agent not found: ${agentRef}`);
  return agent;
}

function resolveBoardKeyExpiresAt(opts: BoardTokenOptions): string | null | undefined {
  const selectedExpiryOptions = [
    Boolean(opts.neverExpires),
    Boolean(opts.expiresAt?.trim()),
    Boolean(opts.ttlDays?.trim()),
  ].filter(Boolean).length;
  if (selectedExpiryOptions > 1) {
    throw new Error("Choose only one of --expires-at, --ttl-days, or --never-expires");
  }
  if (opts.neverExpires) return null;
  if (opts.expiresAt?.trim()) {
    const date = new Date(opts.expiresAt.trim());
    if (!Number.isFinite(date.getTime())) throw new Error(`Invalid --expires-at value: ${opts.expiresAt}`);
    return date.toISOString();
  }
  if (opts.ttlDays?.trim()) {
    const days = Number(opts.ttlDays);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Invalid --ttl-days value: ${opts.ttlDays}`);
    return new Date(Date.now() + Math.floor(days * 24 * 60 * 60 * 1000)).toISOString();
  }
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

const BOARD_SCOPE_PRESET_ALIASES: Record<string, BoardApiKeyScopePreset> = {
  read_only: "read_only",
  "read-only": "read_only",
  company_automation: "company_automation",
  "company-automation": "company_automation",
  full_instance_admin: "full_instance_admin",
  "full-instance-admin": "full_instance_admin",
};

function resolveBoardKeyScopeConfig(
  opts: BoardTokenOptions,
  contextCompanyId: string,
): BoardApiKeyScopeConfig {
  const additionalCompanyIds = opts.scopeCompanyId ?? [];
  if (opts.scopeConfigJson?.trim()) {
    if (opts.scopePreset?.trim() || additionalCompanyIds.length > 0) {
      throw new Error("--scope-config-json cannot be combined with --scope-preset or --scope-company-id");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.scopeConfigJson);
    } catch {
      throw new Error("Invalid --scope-config-json value: expected JSON");
    }
    const scopeConfig = boardApiKeyScopeConfigSchema.parse(parsed);
    if (!scopeConfig.companyIds.includes(contextCompanyId)) {
      throw new Error("--scope-config-json must include --company-id in companyIds");
    }
    return scopeConfig;
  }

  const requestedPreset = opts.scopePreset?.trim() || "company_automation";
  const presetKey = BOARD_SCOPE_PRESET_ALIASES[requestedPreset];
  if (!presetKey) {
    throw new Error(
      `Invalid --scope-preset value: ${requestedPreset}. Expected read_only, company_automation, or full_instance_admin`,
    );
  }
  const preset = BOARD_API_KEY_SCOPE_PRESETS[presetKey];
  return boardApiKeyScopeConfigSchema.parse({
    version: 1,
    kind: "scoped",
    companyIds: [contextCompanyId, ...additionalCompanyIds],
    permissions: [...preset.permissions],
    instanceCapabilities: [...preset.instanceCapabilities],
  });
}

function summarizeBoardKeyScope(scopeConfig: BoardApiKeyScopeConfig | null): string {
  if (!scopeConfig) return "legacy_unrestricted";
  const matchingPreset = (Object.entries(BOARD_API_KEY_SCOPE_PRESETS) as Array<
    [BoardApiKeyScopePreset, (typeof BOARD_API_KEY_SCOPE_PRESETS)[BoardApiKeyScopePreset]]
  >).find(([, preset]) =>
    preset.permissions.length === scopeConfig.permissions.length
    && preset.permissions.every((permission) => scopeConfig.permissions.includes(permission))
    && preset.instanceCapabilities.length === scopeConfig.instanceCapabilities.length
    && preset.instanceCapabilities.every(
      (capability) => scopeConfig.instanceCapabilities.includes(capability),
    ));
  const label = matchingPreset?.[0] ?? "custom";
  return `${label}:${scopeConfig.companyIds.length}_companies`;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}
