import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";

const RUN_COMPLETE_EVENT = "agent.run.finished";
const DEFAULT_TIMEOUT_MS = 5_000;

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function boolEnvEnabled(value: string | undefined): boolean {
  if (!value) return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function asPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function buildPaperclipRunUrl(baseUrl: string | null, runId: string | null): string | null {
  if (!baseUrl || !runId) return null;
  try {
    return new URL(`/heartbeat-runs/${encodeURIComponent(runId)}`, baseUrl).toString();
  } catch {
    return null;
  }
}

function learnerBridgeConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: boolEnvEnabled(env.KATAILYST_LEARNER_BRIDGE_ENABLED),
    endpointUrl: stringField(env.KATAILYST_LEARNER_ENDPOINT_URL),
    secret: stringField(env.HERMES_LEARNER_WEBHOOK_SECRET ?? env.KATAILYST_LEARNER_WEBHOOK_SECRET),
    paperclipBaseUrl: stringField(env.PAPERCLIP_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL),
    timeoutMs: Number.isFinite(Number(env.KATAILYST_LEARNER_TIMEOUT_MS))
      ? Math.max(500, Number(env.KATAILYST_LEARNER_TIMEOUT_MS))
      : DEFAULT_TIMEOUT_MS,
  };
}

export async function maybeDeliverKatailystLearnerRunComplete(event: PluginEvent): Promise<void> {
  if (event.eventType !== RUN_COMPLETE_EVENT) return;

  const config = learnerBridgeConfig();
  if (!config.enabled) return;

  if (!config.endpointUrl || !config.secret) {
    logger.debug(
      {
        eventType: event.eventType,
        hasEndpoint: Boolean(config.endpointUrl),
        hasSecret: Boolean(config.secret),
      },
      "Katailyst Learner bridge not configured; skipping run-complete delivery",
    );
    return;
  }

  const payload = asPayload(event.payload);
  const runId = stringField(payload.runId ?? event.entityId);
  const agentId = stringField(payload.agentId ?? event.actorId);
  const status = stringField(payload.status) ?? "succeeded";

  if (!runId || !agentId) {
    logger.warn({ runId, agentId, eventId: event.eventId }, "Katailyst Learner bridge skipped incomplete event");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.secret}`,
      },
      body: JSON.stringify({
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
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        { runId, agentId, status: response.status },
        "Katailyst Learner bridge delivery rejected by endpoint",
      );
      return;
    }

    logger.info({ runId, agentId, status: response.status }, "Katailyst Learner bridge delivered run-complete event");
  } catch (err) {
    logger.warn({ err, runId, agentId }, "Katailyst Learner bridge delivery failed");
  } finally {
    clearTimeout(timeout);
  }
}
