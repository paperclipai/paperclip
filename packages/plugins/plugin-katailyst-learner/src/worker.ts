import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";

import { RUN_COMPLETE_EVENT } from "./manifest.js";

type KatailystLearnerConfig = {
  enabled?: unknown;
  endpointUrl?: unknown;
  secretRef?: unknown;
  paperclipBaseUrl?: unknown;
};

type PaperclipRunEventPayload = {
  runId?: unknown;
  agentId?: unknown;
  status?: unknown;
  invocationSource?: unknown;
  triggerDetail?: unknown;
  issueId?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  usage?: unknown;
};

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getConfigValue(config: KatailystLearnerConfig) {
  return {
    enabled: config.enabled !== false,
    endpointUrl: stringField(config.endpointUrl),
    secretRef: stringField(config.secretRef),
    paperclipBaseUrl: stringField(config.paperclipBaseUrl),
  };
}

function asRunPayload(payload: unknown): PaperclipRunEventPayload {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as PaperclipRunEventPayload
    : {};
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildPaperclipRunUrl(baseUrl: string | null, runId: string | null): string | null {
  if (!baseUrl || !runId) return null;
  try {
    return new URL(`/heartbeat-runs/${encodeURIComponent(runId)}`, baseUrl).toString();
  } catch {
    return null;
  }
}

async function logActivity(
  ctx: PluginContext,
  event: PluginEvent,
  message: string,
  metadata: Record<string, unknown>,
) {
  await ctx.activity.log({
    companyId: event.companyId,
    message,
    entityType: event.entityType,
    entityId: event.entityId,
    metadata,
  });
}

async function deliverRunComplete(ctx: PluginContext, event: PluginEvent) {
  const config = getConfigValue(await ctx.config.get() as KatailystLearnerConfig);
  const payload = asRunPayload(event.payload);
  const runId = stringField(payload.runId ?? event.entityId);
  const agentId = stringField(payload.agentId ?? event.actorId);
  const status = stringField(payload.status);

  if (!config.enabled) {
    ctx.logger.info("Katailyst Learner delivery skipped because the plugin is disabled", { runId });
    return;
  }

  if (!config.endpointUrl || !config.secretRef) {
    await logActivity(ctx, event, "Katailyst Learner webhook is not configured", {
      runId,
      missingEndpointUrl: !config.endpointUrl,
      missingSecretRef: !config.secretRef,
    });
    return;
  }

  if (!runId || !agentId || !status) {
    await logActivity(ctx, event, "Katailyst Learner skipped an incomplete run event", {
      runId,
      agentId,
      status,
    });
    return;
  }

  const secret = await ctx.secrets.resolve(config.secretRef);
  const requestBody = {
    source: "paperclip",
    event_id: event.eventId,
    event_type: event.eventType,
    company_id: event.companyId,
    run_id: runId,
    agent_id: agentId,
    issue_id: stringField(payload.issueId),
    status,
    invocation_source: stringField(payload.invocationSource),
    trigger_detail: stringField(payload.triggerDetail),
    started_at: stringField(payload.startedAt),
    finished_at: stringField(payload.finishedAt),
    paperclip_url: buildPaperclipRunUrl(config.paperclipBaseUrl, runId),
    usage: asObject(payload.usage),
  };

  const response = await ctx.http.fetch(config.endpointUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(requestBody),
  });

  const delivery = {
    runId,
    agentId,
    status,
    katailystStatus: response.status,
    deliveredAt: new Date().toISOString(),
  };

  await ctx.state.set(
    { scopeKind: "company", scopeId: event.companyId, stateKey: "last-learner-delivery" },
    delivery,
  );

  if (!response.ok) {
    await logActivity(ctx, event, "Katailyst Learner rejected a run-complete event", delivery);
    ctx.logger.warn("Katailyst Learner delivery failed", delivery);
    return;
  }

  await logActivity(ctx, event, "Sent Paperclip run-complete event to Katailyst Learner", delivery);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on(RUN_COMPLETE_EVENT, async (event) => {
      await deliverRunComplete(ctx, event);
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Katailyst Learner plugin is ready to deliver successful Paperclip run events.",
      details: {
        subscribedEvent: RUN_COMPLETE_EVENT,
      },
    };
  },

  async onValidateConfig(config) {
    const typed = getConfigValue(config as KatailystLearnerConfig);
    const errors: string[] = [];
    if (typed.enabled && !typed.endpointUrl) errors.push("endpointUrl is required when enabled");
    if (typed.enabled && !typed.secretRef) errors.push("secretRef is required when enabled");
    return { ok: errors.length === 0, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
