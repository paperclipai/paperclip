import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ScopeKey,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  PLUGIN_ID,
  TOOL_NAMES,
} from "./constants.js";

/**
 * Builtin routing registry. Each routing carries enough to switch an agent's
 * adapter config (command/model/effort/env) plus capability/availability
 * metadata. `free: true` marks lanes that must not consume Anthropic/claude
 * quota — the board's NON-NEGOTIABLE cost policy.
 *
 * env values use `{{VAR}}` placeholders resolved from host secrets at apply
 * time (see resolveEnvBindings). Sensitive keys are stored as secret-refs.
 */
const BUILTIN_ROUTINGS: Routing[] = [
  {
    id: "cc",
    label: "Claude Code (claude.ai)",
    orchestrator: "claude_code",
    adapterType: "claude_local",
    command: "claude",
    model: null,
    effort: "high",
    engine: "cli",
    free: false,
    badges: ["Claude UI", "claude.ai latest", "max effort", "Artifacts", "MCPs"],
    note: "Premium lane. FREE-LANES-ONLY policy blocks this by default.",
  },
  {
    id: "cc-ds",
    label: "Claude Code (DeepSeek V4 Flash)",
    orchestrator: "claude_code",
    adapterType: "claude_local",
    command: "claude",
    model: "deepseek-v4-flash",
    free: false,
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "{{DEEPSEEK_API_KEY}}",
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash",
    },
    badges: ["Claude UI", "DeepSeek", "cheap"],
    note: "Uses Anthropic quota path — not free.",
  },
  {
    id: "cc-bridge",
    label: "Claude Code (claude.ai + DeepSeek subagents)",
    orchestrator: "claude_code",
    adapterType: "claude_local",
    command: "ccb",
    model: "claude-haiku-4-5",
    free: false,
    env: {
      ANTHROPIC_MODEL: "claude-haiku-4-5",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
    },
    badges: ["Claude UI", "Artifacts", "ccb daemon"],
    note: "Uses Anthropic quota — not free.",
  },
  {
    id: "cc-or",
    label: "Claude Code (OpenRouter free)",
    orchestrator: "claude_code",
    adapterType: "claude_local",
    command: "claude",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    free: false,
    env: {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "{{OPENROUTER_API_KEY}}",
      ANTHROPIC_MODEL: "nvidia/nemotron-3-super-120b-a12b:free",
      ANTHROPIC_SMALL_FAST_MODEL: "nvidia/nemotron-3-nano-30b-a3b:free",
    },
    badges: ["Claude UI", "OpenRouter free"],
    note: "Runs through claude binary — blocked under free-lanes-only.",
  },
  {
    id: "oc-ds",
    label: "OpenCode (DeepSeek V4 Flash)",
    orchestrator: "opencode",
    adapterType: "opencode_local",
    command: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    free: true,
    env: { DEEPSEEK_API_KEY: "{{DEEPSEEK_API_KEY}}" },
    badges: ["OpenCode", "DeepSeek", "zero-Anthropic"],
    note: "Default free lane.",
  },
  {
    id: "oc-or",
    label: "OpenCode (OpenRouter free)",
    orchestrator: "opencode",
    adapterType: "opencode_local",
    command: "opencode",
    model: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    free: true,
    env: { OPENROUTER_API_KEY: "{{OPENROUTER_API_KEY}}" },
    badges: ["OpenCode", "OpenRouter free"],
    note: "Free; OpenRouter free-tier quotas apply.",
  },
  {
    id: "oc-nim",
    label: "OpenCode (NVIDIA NIM)",
    orchestrator: "opencode",
    adapterType: "opencode_local",
    command: "opencode",
    model: "nvidia/nemotron-3-super-120b-a12b",
    free: true,
    env: { NVIDIA_API_KEY: "{{NVIDIA_API_KEY}}" },
    badges: ["OpenCode", "NIM", "40 req/min"],
    note: "Free; requires NVIDIA_API_KEY.",
  },
  {
    id: "oc-qw",
    label: "OpenCode (Ollama Qwen3 local)",
    orchestrator: "opencode",
    adapterType: "opencode_local",
    command: "opencode",
    model: "ollama/qwen3-coder:latest",
    free: true,
    env: {},
    badges: ["OpenCode", "local", "offline"],
    note: "Free, offline; needs Ollama running.",
  },
  {
    id: "oc-free",
    label: "OpenCode (fallback provider)",
    orchestrator: "opencode",
    adapterType: "opencode_local",
    command: "opencode",
    model: null,
    free: true,
    env: {},
    badges: ["OpenCode", "fallback"],
    note: "Free; uses any logged-in provider.",
  },
];

type Routing = {
  id: string;
  label: string;
  orchestrator: "claude_code" | "opencode";
  adapterType: string;
  command?: string;
  model?: string | null;
  effort?: string;
  engine?: string;
  free?: boolean;
  env?: Record<string, string>;
  badges?: string[];
  note?: string;
  builtin?: boolean;
};

type RoutingConfig = {
  freeLanesOnly?: boolean;
  defaultRouting?: string;
  showSidebarEntry?: boolean;
};

const ROUTING_STATE_KEY = "routings";
const DEFAULT_CONFIG: RoutingConfig = {
  freeLanesOnly: true,
  defaultRouting: "oc-ds",
  showSidebarEntry: true,
};

function routingScope(ctx: PluginContext): ScopeKey {
  return {
    scopeKind: "instance",
    namespace: "routing-board",
    stateKey: ROUTING_STATE_KEY,
  };
}

function isFree(r: Routing): boolean {
  return r.free !== false;
}

function availability(r: Routing, cfg: RoutingConfig): { available: boolean; reason?: string } {
  if (cfg.freeLanesOnly && !isFree(r)) {
    return { available: false, reason: "blocked by free-lanes-only policy (claude quota)" };
  }
  return { available: true };
}

async function getRegistry(ctx: PluginContext): Promise<Routing[]> {
  const stored = (await ctx.state.get(routingScope(ctx)).catch(() => null)) as Routing[] | null;
  const builtins = BUILTIN_ROUTINGS.map((r) => ({ ...r, builtin: true }));
  if (!stored || !Array.isArray(stored)) return builtins;
  const custom = stored.filter((r) => !r.builtin);
  return [...builtins, ...custom];
}

async function getConfig(ctx: PluginContext): Promise<RoutingConfig> {
  const raw = await ctx.config.get().catch(() => ({}));
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) };
}

function resolveEnvTemplate(template: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(template ?? {}).map(([k, v]) => [
      k,
      String(v).replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
        // Values are resolved from host secrets by the caller; here we keep the
        // placeholder if not otherwise resolvable. In practice the UI passes
        // secret-ref bindings. Keep placeholders so strict mode + secret-ref
        // resolution can run on the host side.
        return `{{${name}}}`;
      }),
    ]),
  );
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Routing board plugin starting");

    // ---- list routings ----
    ctx.tools.register(
      TOOL_NAMES.listRoutings,
      {
        displayName: "Routing — list",
        description: "List routings with availability and per-agent defaults.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, runCtx): Promise<ToolResult> => {
        const cfg = await getConfig(ctx);
        const registry = await getRegistry(ctx);
        const agents = await ctx.agents.list({ companyId: runCtx.companyId, limit: 100, offset: 0 }).catch(() => []);
        const availabilityMap = Object.fromEntries(
          registry.map((r) => [r.id, availability(r, { ...DEFAULT_CONFIG, ...cfg })]),
        );
        return {
          content: JSON.stringify(
            {
              freeLanesOnly: cfg.freeLanesOnly ?? DEFAULT_CONFIG.freeLanesOnly,
              routings: registry.map((r) => ({
                id: r.id,
                label: r.label,
                free: isFree(r),
                badges: r.badges ?? [],
                available: availabilityMap[r.id]?.available,
                reason: availabilityMap[r.id]?.reason,
              })),
              agents: agents.map((a) => ({ id: a.id, name: a.name, adapterType: a.adapterType })),
            },
            null,
            2,
          ),
        };
      },
    );

    // ---- get routing ----
    ctx.tools.register(
      TOOL_NAMES.getRouting,
      {
        displayName: "Routing — get",
        description: "Get one routing's full config.",
        parametersSchema: {
          type: "object",
          properties: { routingId: { type: "string" } },
          required: ["routingId"],
        },
      },
      async (params): Promise<ToolResult> => {
        const { routingId } = params as { routingId?: string };
        if (!routingId) return { error: "routingId is required" };
        const registry = await getRegistry(ctx);
        const found = registry.find((r) => r.id === routingId);
        if (!found) return { error: `routing '${routingId}' not found` };
        return {
          content: JSON.stringify(
            {
              ...found,
              env: resolveEnvTemplate(found.env),
            },
            null,
            2,
          ),
        };
      },
    );

    // ---- set default routing on an agent ----
    // NOTE: the plugin SDK's curated client exposes no `agents.update`, and the
    // host client's `http.fetch` is outbound-only. Applying a routing to an
    // agent's adapter config is therefore done by the UI against Paperclip's own
    // REST API (PATCH /agents/:id with replaceAdapterConfig:true), which runs in
    // the authenticated board session. This tool records the default choice in
    // plugin state so the UI + other tools can read it back.
    ctx.tools.register(
      TOOL_NAMES.setDefaultRouting,
      {
        displayName: "Routing — set default (record)",
        description: "Record an agent's default routing choice in plugin state (UI applies it via the Paperclip API).",
        parametersSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            routingId: { type: "string" },
          },
          required: ["agentId", "routingId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const { agentId, routingId } = params as { agentId?: string; routingId?: string };
        if (!agentId || !routingId) return { error: "agentId and routingId are required" };
        const cfg = await getConfig(ctx);
        const registry = await getRegistry(ctx);
        const routing = registry.find((r) => r.id === routingId);
        if (!routing) return { error: `routing '${routingId}' not found` };
        const avail = availability(routing, { ...DEFAULT_CONFIG, ...cfg });
        if (!avail.available) return { error: `routing unavailable: ${avail.reason}` };

        const scope: ScopeKey = {
          scopeKind: "company",
          scopeId: runCtx.companyId,
          namespace: "routing-board",
          stateKey: `default:${agentId}`,
        };
        await ctx.state.set(scope, { routingId });
        return {
          content: `Default routing for agent ${agentId} recorded as '${routingId}'. (UI applies it via PATCH /agents/:id.)`,
          data: { agentId, routingId, recorded: true },
        };
      },
    );

    // ---- create routing ----
    ctx.tools.register(
      TOOL_NAMES.createRouting,
      {
        displayName: "Routing — create",
        description: "Add a routing to the additive registry.",
        parametersSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            adapterType: { type: "string" },
            orchestrator: { type: "string" },
            model: { type: "string" },
            command: { type: "string" },
            env: { type: "object", additionalProperties: { type: "string" } },
            badges: { type: "array", items: { type: "string" } },
            free: { type: "boolean" },
            note: { type: "string" },
          },
          required: ["id", "label", "adapterType"],
        },
      },
      async (params): Promise<ToolResult> => {
        const p = params as Partial<Routing> & { id?: string };
        if (!p.id || !p.label) return { error: "id and label are required" };
        const registry = await getRegistry(ctx);
        if (registry.some((r) => r.id === p.id)) return { error: `routing '${p.id}' already exists` };
        const created: Routing = {
          id: p.id,
          label: p.label,
          orchestrator: p.orchestrator === "claude_code" ? "claude_code" : "opencode",
          adapterType: p.adapterType ?? "opencode_local",
          model: p.model ?? null,
          command: p.command,
          env: p.env,
          badges: p.badges ?? [],
          free: p.free !== false,
          note: p.note,
          builtin: false,
        };
        const stored = await getRegistry(ctx);
        const custom = stored.filter((r) => !r.builtin);
        await ctx.state.set(routingScope(ctx), [...custom, created]);
        return { content: `Routing '${p.id}' added.`, data: { routingId: p.id } };
      },
    );

    // ---- delete routing ----
    ctx.tools.register(
      TOOL_NAMES.deleteRouting,
      {
        displayName: "Routing — delete",
        description: "Remove a non-builtin routing.",
        parametersSchema: {
          type: "object",
          properties: { routingId: { type: "string" } },
          required: ["routingId"],
        },
      },
      async (params): Promise<ToolResult> => {
        const { routingId } = params as { routingId?: string };
        if (!routingId) return { error: "routingId is required" };
        const stored = await getRegistry(ctx);
        const target = stored.find((r) => r.id === routingId);
        if (!target) return { error: `routing '${routingId}' not found` };
        if (target.builtin) return { error: "builtin routing cannot be deleted" };
        const custom = stored.filter((r) => !r.builtin && r.id !== routingId);
        await ctx.state.set(routingScope(ctx), custom);
        return { content: `Routing '${routingId}' deleted.` };
      },
    );

    // ---- heartbeat with routing override ----
    // NOTE: same constraint as setDefaultRouting — the SDK client cannot mutate
    // agent adapter config, so the actual heartbeat invocation with a routing
    // override is performed by the UI via the Paperclip API (PATCH /agents/:id
    // then POST /agents/:id/heartbeat/invoke). This tool records intent.
    ctx.tools.register(
      TOOL_NAMES.invokeHeartbeatWithRouting,
      {
        displayName: "Routing — heartbeat (record intent)",
        description: "Record a heartbeat-with-routing intent for an agent (UI performs the API calls).",
        parametersSchema: {
          type: "object",
          properties: { agentId: { type: "string" }, routingId: { type: "string" } },
          required: ["agentId", "routingId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const { agentId, routingId } = params as { agentId?: string; routingId?: string };
        if (!agentId || !routingId) return { error: "agentId and routingId are required" };
        const cfg = await getConfig(ctx);
        const registry = await getRegistry(ctx);
        const routing = registry.find((r) => r.id === routingId);
        if (!routing) return { error: `routing '${routingId}' not found` };
        const avail = availability(routing, { ...DEFAULT_CONFIG, ...cfg });
        if (!avail.available) return { error: `routing unavailable: ${avail.reason}` };

        const scope: ScopeKey = {
          scopeKind: "company",
          scopeId: runCtx.companyId,
          namespace: "routing-board",
          stateKey: `heartbeat:${agentId}`,
        };
        await ctx.state.set(scope, { routingId, at: new Date().toISOString() });
        return {
          content: `Heartbeat-with-routing intent recorded for agent ${agentId} → '${routingId}'.`,
          data: { agentId, routingId, recorded: true },
        };
      },
    );

    // UI data endpoint for the Routing page.
    ctx.data.register("routing-board-overview", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const cfg = await getConfig(ctx);
      const registry = await getRegistry(ctx);
      const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 }).catch(() => []);
      return {
        freeLanesOnly: cfg.freeLanesOnly ?? DEFAULT_CONFIG.freeLanesOnly,
        defaultRouting: cfg.defaultRouting ?? DEFAULT_CONFIG.defaultRouting,
        routings: registry.map((r) => ({
          ...r,
          available: availability(r, { ...DEFAULT_CONFIG, ...cfg }).available,
          reason: availability(r, { ...DEFAULT_CONFIG, ...cfg }).reason,
        })),
        agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status, adapterType: a.adapterType })),
      };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
