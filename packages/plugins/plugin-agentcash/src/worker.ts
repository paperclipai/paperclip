import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";

import { TOOL_NAMES } from "./constants.js";
import {
  checkWallet,
  isWalletLoaded,
  agentcashFetch,
  agentcashDiscover,
  agentcashCheckSchema,
  agentcashGetBalance,
  type FetchParams,
  type DiscoverParams,
  type CheckSchemaParams,
} from "./agentcash-adapter.js";

// ---------------------------------------------------------------------------
// Cost event bridge — reports USDC spend to Paperclip's cost-events endpoint
// ---------------------------------------------------------------------------

async function reportCostEvent(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  payment: { price: string; protocol: string; network: string; txHash: string | null },
  endpoint: string,
): Promise<void> {
  const usdcAmount = parseFloat(payment.price);
  const costCents = Math.round(usdcAmount * 100);
  if (!costCents || costCents === 0) return;

  let hostname = "unknown";
  let pathname = endpoint;
  try {
    const parsed = new URL(endpoint);
    hostname = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    // leave defaults
  }

  const apiBase = process.env.PAPERCLIP_API_URL ?? "http://localhost:4100/api";

  try {
    await ctx.http.fetch(
      `${apiBase}/companies/${runCtx.companyId}/cost-events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: runCtx.agentId,
          provider: hostname,
          biller: "agentcash",
          billingType: "metered_api",
          model: pathname,
          inputTokens: 0,
          outputTokens: 0,
          costCents,
          occurredAt: new Date().toISOString(),
        }),
      },
    );
  } catch (err) {
    ctx.logger.warn("Failed to report cost event to Paperclip", {
      error: err instanceof Error ? err.message : String(err),
      endpoint,
      costCents,
    });
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function registerTools(ctx: PluginContext): Promise<void> {
  // -- fetch ----------------------------------------------------------------
  ctx.tools.register(
    TOOL_NAMES.fetch,
    {
      displayName: "AgentCash Fetch",
      description:
        "HTTP fetch with automatic x402 payment and SIWX authentication. Call agentcash-check-schema first for unfamiliar endpoints.",
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
          body: {},
          headers: { type: "object", additionalProperties: { type: "string" } },
          maxAmount: { type: "number" },
        },
        required: ["url"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const input = params as FetchParams;
      if (!input.url) return { error: "url is required" };

      try {
        const result = await agentcashFetch(input);

        if (result.paymentInfo) {
          await reportCostEvent(ctx, runCtx, result.paymentInfo, input.url);

          await ctx.activity.log({
            companyId: runCtx.companyId,
            message: `AgentCash payment: $${result.paymentInfo.price} USDC to ${input.url}`,
            entityType: "agent",
            entityId: runCtx.agentId,
            metadata: {
              url: input.url,
              costUsd: result.paymentInfo.price,
              network: result.paymentInfo.network,
              txHash: result.paymentInfo.txHash,
            },
          });
        }

        let responseBody: string;
        try {
          const parsed = JSON.parse(result.body);
          responseBody = JSON.stringify(parsed, null, 2);
        } catch {
          responseBody = result.body;
        }

        return {
          content: responseBody,
          data: {
            paymentInfo: result.paymentInfo,
          },
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // -- discover -------------------------------------------------------------
  ctx.tools.register(
    TOOL_NAMES.discover,
    {
      displayName: "AgentCash Discover Endpoints",
      description:
        "List available endpoints at an API origin with descriptions and auth modes.",
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          includeGuidance: { type: "boolean" },
        },
        required: ["url"],
      },
    },
    async (params): Promise<ToolResult> => {
      const input = params as DiscoverParams;
      if (!input.url) return { error: "url is required" };

      try {
        const result = await agentcashDiscover(input);

        return {
          content: JSON.stringify(result, null, 2),
          data: result,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // -- check schema ---------------------------------------------------------
  ctx.tools.register(
    TOOL_NAMES.checkSchema,
    {
      displayName: "AgentCash Check Endpoint Schema",
      description:
        "Get input/output schema, auth mode, and pricing for a single endpoint.",
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
          body: {},
        },
        required: ["url"],
      },
    },
    async (params): Promise<ToolResult> => {
      const input = params as CheckSchemaParams;
      if (!input.url) return { error: "url is required" };

      try {
        const result = await agentcashCheckSchema(input);

        return {
          content: JSON.stringify(result, null, 2),
          data: result,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // -- get balance ----------------------------------------------------------
  ctx.tools.register(
    TOOL_NAMES.getBalance,
    {
      displayName: "AgentCash Get Balance",
      description: "Get total USDC wallet balance across all supported networks.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (): Promise<ToolResult> => {
      try {
        const result = await agentcashGetBalance();

        return {
          content: `Total balance: $${result.totalBalance.toFixed(2)} USDC`,
          data: {
            totalBalance: result.totalBalance,
            accounts: result.accounts,
          },
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("AgentCash plugin starting...");

    const walletOk = await checkWallet();
    if (walletOk) {
      ctx.logger.info("AgentCash wallet loaded");
    } else {
      ctx.logger.warn("AgentCash wallet not available — tools will attempt lazy initialization");
    }

    await registerTools(ctx);
    ctx.logger.info("AgentCash plugin ready");
  },

  async onHealth() {
    return {
      status: isWalletLoaded() ? "ok" : "degraded",
      message: isWalletLoaded()
        ? "Wallet loaded, tools registered"
        : "Wallet not confirmed at startup — tools will operate and surface errors if wallet is missing",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
