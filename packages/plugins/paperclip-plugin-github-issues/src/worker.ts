import { definePlugin } from "@paperclipai/plugin-sdk";
import { verifySignature } from "./verify.js";
import { acquireDelivery } from "./idempotency.js";
import { dispatch, type Handlers } from "./dispatch.js";
import { logDelivery } from "./observability.js";
import { handleIssueOpened }    from "./handlers/issue-opened.js";
import { handleIssueEdited }    from "./handlers/issue-edited.js";
import { handleIssueClosed }    from "./handlers/issue-closed.js";
import { handleCommentCreated } from "./handlers/comment-created.js";
import { handleWorkflowRun }    from "./handlers/workflow-run.js";
import { handlePrMerged }       from "./handlers/pr-merged.js";
import type { PluginConfig } from "./types.js";

const HANDLERS: Handlers = {
  issueOpened:    handleIssueOpened,
  issueEdited:    handleIssueEdited,
  issueClosed:    handleIssueClosed,
  commentCreated: handleCommentCreated,
  workflowRun:    handleWorkflowRun,
  prMerged:       handlePrMerged,
};

function header(headers: Record<string, string | string[]>, key: string): string {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

/**
 * Test seam: same body the SDK calls, exported for integration tests.
 * Receives `ctx` and `config` explicitly. In production, captured via closure in setup().
 */
export async function handleWebhook(input: any, ctx: any, config: PluginConfig): Promise<void> {
  const start = Date.now();
  const event    = header(input.headers, "x-github-event");
  const delivery = header(input.headers, "x-github-delivery") || input.requestId;
  const sig      = header(input.headers, "x-hub-signature-256");
  const repo     = (input.parsedBody as any)?.repository?.full_name;
  const action   = (input.parsedBody as any)?.action;

  try {
    if (!verifySignature(input.rawBody, sig, config.hmacSecret)) {
      logDelivery({ deliveryId: delivery, event, action, repo, outcome: "filtered", durationMs: Date.now() - start, error: "bad_signature" });
      return;
    }

    const acquired = await acquireDelivery(ctx.state, config.companyId, delivery);
    if (!acquired) {
      logDelivery({ deliveryId: delivery, event, action, repo, outcome: "duplicate", durationMs: Date.now() - start });
      return;
    }

    const ctxWithConfig = { ...ctx, config };
    await dispatch(event, input.parsedBody, ctxWithConfig, HANDLERS);
    logDelivery({ deliveryId: delivery, event, action, repo, outcome: "created", durationMs: Date.now() - start });
  } catch (err) {
    logDelivery({ deliveryId: delivery, event, action, repo, outcome: "error", durationMs: Date.now() - start, error: String(err) });
    throw err;
  }
}

// Module-level captured context for production use (avoids `this` issues with definePlugin)
let _capturedCtx: any = null;
let _capturedCfg: PluginConfig | null = null;

export default definePlugin({
  async setup(ctx) {
    _capturedCtx = ctx;
    _capturedCfg = (await ctx.config.get()) as PluginConfig;
  },
  async onWebhook(input) {
    if (!_capturedCtx || !_capturedCfg) {
      throw new Error("Plugin not initialized: setup() did not run before onWebhook");
    }
    return handleWebhook(input, _capturedCtx, _capturedCfg);
  },
});
