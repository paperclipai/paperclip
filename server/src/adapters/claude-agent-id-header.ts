import type { ServerAdapterModule } from "./types.js";

type ClaudeExecute = ServerAdapterModule["execute"];

const AGENT_ID_HEADER = "X-Anthropic-Agent-Id";

/**
 * Wraps the claude_local execute so every request the spawned Claude Code makes
 * carries `X-Anthropic-Agent-Id: <agentId>` via ANTHROPIC_CUSTOM_HEADERS. A proxy
 * such as better-ccflare reads that header to attribute requests per agent for
 * downstream cost/token telemetry.
 *
 * The header is merged into `config.env` — the env the adapter actually forwards
 * into the spawned process — not `agent.adapterConfig.env`, which is resolved
 * upstream before execute runs and is never read by the Claude adapter.
 */
export function stampClaudeAgentIdHeader(inner: ClaudeExecute): ClaudeExecute {
  return (ctx) => {
    const agent = (ctx as { agent?: { id?: string } }).agent;
    // Strip CR/LF and bound length to prevent HTTP header injection — agentId is
    // interpolated into ANTHROPIC_CUSTOM_HEADERS, which is forwarded as a header.
    const agentId = agent?.id
      ? String(agent.id).replace(/[\r\n]/g, "").trim().slice(0, 256)
      : undefined;
    if (!agentId) return inner(ctx);
    const config = ((ctx as { config?: unknown }).config ?? {}) as Record<string, unknown>;
    const env: Record<string, unknown> = {
      ...((config.env as Record<string, unknown> | undefined) ?? {}),
    };
    const existing =
      typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" ? env.ANTHROPIC_CUSTOM_HEADERS : "";
    // Respect an X-Anthropic-Agent-Id already set via manual override — appending a
    // second line would send a duplicate header to the proxy.
    if (/(^|\n)\s*X-Anthropic-Agent-Id\s*:/i.test(existing)) return inner(ctx);
    const header = `${AGENT_ID_HEADER}: ${agentId}`;
    env.ANTHROPIC_CUSTOM_HEADERS = existing ? `${existing}\n${header}` : header;
    return inner({ ...ctx, config: { ...config, env } } as Parameters<ClaudeExecute>[0]);
  };
}
