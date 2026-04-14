import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { FEEDBACK_PRIORITIES } from "./worker_internal.js";
import { FEEDBACK_STATE_KEY, normalizeFeedbackPayload } from "./worker_internal.js";
import { TOOL_NAMES, WEBHOOK_KEYS, type FeedbackSource } from "./constants.js";

type PluginConfig = {
  defaultCompanyId?: string;
  defaultProjectId?: string;
  defaultGoalId?: string;
  defaultParentId?: string;
  appendRawPayloadComment?: boolean;
  webhookAuthSecretRef?: string;
};

type IngestParams = {
  source: FeedbackSource;
  payload: Record<string, unknown>;
  companyId?: string;
  title?: string;
  description?: string;
  priority?: string;
  labels?: string[];
  projectId?: string;
  goalId?: string;
  parentId?: string;
  rawPayloadComment?: boolean;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPriority(value: unknown): "critical" | "high" | "medium" | "low" {
  if (typeof value !== "string") return "medium";
  const normalized = value.trim().toLowerCase();
  return FEEDBACK_PRIORITIES.has(normalized)
    ? (normalized as "critical" | "high" | "medium" | "low")
    : "medium";
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

async function readConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  return {
    defaultCompanyId: asString(raw.defaultCompanyId),
    defaultProjectId: asString(raw.defaultProjectId),
    defaultGoalId: asString(raw.defaultGoalId),
    defaultParentId: asString(raw.defaultParentId),
    appendRawPayloadComment: Boolean(raw.appendRawPayloadComment),
    webhookAuthSecretRef: asString(raw.webhookAuthSecretRef),
  };
}

function buildIssueDescription(input: {
  source: FeedbackSource;
  normalizedTitle: string;
  normalizedDescription: string;
  labels: string[];
  sourceRef?: string;
  payload: Record<string, unknown>;
}): string {
  const lines = [
    `Source: ${input.source}`,
    input.sourceRef ? `Source Ref: ${input.sourceRef}` : undefined,
    input.labels.length > 0 ? `Labels: ${input.labels.join(", ")}` : undefined,
    "",
    input.normalizedDescription,
    "",
    "Payload Snapshot:",
    "```json",
    truncate(JSON.stringify(input.payload, null, 2), 4000),
    "```",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

async function ingestFeedback(
  ctx: PluginContext,
  params: IngestParams,
  runCtx: Partial<ToolRunContext>,
): Promise<{ issueId: string; title: string; priority: string; source: FeedbackSource }> {
  const config = await readConfig(ctx);
  const source = params.source;
  const payload = asObject(params.payload);
  const normalized = normalizeFeedbackPayload(source, payload);

  const companyId =
    asString(params.companyId) ??
    asString(runCtx.companyId) ??
    config.defaultCompanyId;
  if (!companyId) throw new Error("companyId is required (tool context, params, or plugin config defaultCompanyId)");

  const labels = Array.isArray(params.labels)
    ? params.labels.filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    : [];

  const title = asString(params.title) ?? normalized.title;
  const description = asString(params.description) ?? normalized.description;
  const priority = toPriority(asString(params.priority) ?? normalized.priority);

  const issue = await ctx.issues.create({
    companyId,
    title,
    description: buildIssueDescription({
      source,
      normalizedTitle: title,
      normalizedDescription: description,
      labels,
      sourceRef: normalized.sourceRef,
      payload,
    }),
    priority,
    projectId: asString(params.projectId) ?? config.defaultProjectId,
    goalId: asString(params.goalId) ?? config.defaultGoalId,
    parentId: asString(params.parentId) ?? config.defaultParentId,
  });

  if (params.rawPayloadComment || config.appendRawPayloadComment) {
    await ctx.issues.createComment(
      issue.id,
      `Raw payload for ${source}:\n\n\`\`\`json\n${truncate(JSON.stringify(payload, null, 2), 6000)}\n\`\`\``,
      companyId,
    );
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: FEEDBACK_STATE_KEY },
    {
      issueId: issue.id,
      source,
      ingestedAt: new Date().toISOString(),
      title,
      priority,
    },
  );

  return {
    issueId: issue.id,
    title,
    priority,
    source,
  };
}

async function parseWebhookPayload(input: PluginWebhookInput): Promise<Record<string, unknown>> {
  if (input.parsedBody && typeof input.parsedBody === "object") {
    return asObject(input.parsedBody);
  }
  if (!input.rawBody) return {};
  try {
    return asObject(JSON.parse(input.rawBody));
  } catch {
    return {};
  }
}

async function authorizeWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const config = await readConfig(ctx);
  if (!config.webhookAuthSecretRef) return;

  const expected = await ctx.secrets.resolve(config.webhookAuthSecretRef);
  const header = input.headers["x-feedback-token"];
  const token = Array.isArray(header) ? header[0] : header;

  if (!token || token !== expected) {
    throw new Error("Unauthorized webhook: invalid x-feedback-token");
  }
}

function sourceFromEndpoint(endpointKey: string): FeedbackSource {
  if (endpointKey === WEBHOOK_KEYS.JIRA) return "jira";
  if (endpointKey === WEBHOOK_KEYS.BITBUCKET) return "bitbucket";
  if (endpointKey === WEBHOOK_KEYS.SLACK) return "slack";
  throw new Error(`Unsupported endpointKey '${endpointKey}'`);
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginContext = ctx;
    ctx.tools.register(
      TOOL_NAMES.INGEST_FEEDBACK,
      {
        displayName: "Ingest Feedback",
        description: "Normalize Jira, Bitbucket, or Slack payloads and create a Paperclip issue.",
        parametersSchema: {
          type: "object",
          properties: {
            source: { type: "string", enum: ["jira", "bitbucket", "slack"] },
            payload: { type: "object" },
            companyId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
            labels: { type: "array", items: { type: "string" } },
            projectId: { type: "string" },
            goalId: { type: "string" },
            parentId: { type: "string" },
            rawPayloadComment: { type: "boolean" },
          },
          required: ["source", "payload"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        try {
          const result = await ingestFeedback(ctx, params as IngestParams, runCtx);
          return {
            content: `Created issue ${result.issueId} from ${result.source} feedback.`,
            data: result,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: `Failed to ingest feedback: ${message}`,
            data: null,
          };
        }
      },
    );
  },

  async onWebhook(input) {
    if (!pluginContext) {
      throw new Error("Plugin context is not initialized");
    }
    await authorizeWebhook(pluginContext, input);
    const payload = await parseWebhookPayload(input);
    const source = sourceFromEndpoint(input.endpointKey);
    await ingestFeedback(
      pluginContext,
      {
        source,
        payload,
        companyId: asString(payload.companyId),
      },
      {},
    );
  },

  async onHealth() {
    return { status: "ok", message: "Feedback Collection plugin ready" };
  },
});

let pluginContext: PluginContext | null = null;

export default plugin;
runWorker(plugin, import.meta.url);
