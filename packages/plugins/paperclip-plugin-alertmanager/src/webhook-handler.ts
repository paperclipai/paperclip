/**
 * Webhook handler logic — separated from `worker.ts` so tests can drive it
 * without triggering the RPC host bootstrap that runs at module load time.
 *
 * All host interaction goes through the `PluginContext` argument; the
 * resolved bearer token is passed in explicitly so the handler stays
 * independent of how the operator chose to supply it (secret-ref vs inline).
 */

import { timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { ACCEPTED_SCHEMA_VERSIONS, STATE_KEYS, WEBHOOK_KEYS } from "./constants.js";
import {
  alertMatchesLabelFilter,
  buildIssueDescription,
  buildIssueTitle,
  effectiveAlertStatus,
  severityToPriority,
} from "./issue-mapping.js";
import { resolveAssigneeUserId } from "./owner-resolver.js";
import {
  ORIGIN_KIND,
  type AlertStateRecord,
  type AlertmanagerAlert,
  type AlertmanagerPluginConfig,
  type AlertmanagerWebhookPayload,
} from "./types.js";

export class WebhookUnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "WebhookUnauthorizedError";
  }
}

/**
 * Verify `Authorization: Bearer <token>` against the configured token.
 * Constant-time comparison; rejects on missing token, missing header,
 * length mismatch.
 */
export function verifyBearerToken(
  headers: Record<string, string | string[]>,
  expectedToken: string | null,
): boolean {
  if (!expectedToken) return false;
  const raw =
    pickHeader(headers, "authorization") ??
    pickHeader(headers, "Authorization");
  if (!raw) return false;
  const expected = `Bearer ${expectedToken}`;
  if (raw.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(raw), Buffer.from(expected));
}

function pickHeader(
  headers: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

/**
 * Type-guard that an unknown body matches the AM v2 envelope shape.
 * Doesn't validate every label/annotation entry — Alertmanager always
 * sends strings and rejecting on a stray non-string value would be fragile.
 */
export function isAlertmanagerPayload(
  body: unknown,
): body is AlertmanagerWebhookPayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.version !== "string") return false;
  if (typeof b.status !== "string") return false;
  if (!Array.isArray(b.alerts)) return false;
  for (const alert of b.alerts) {
    if (!alert || typeof alert !== "object") return false;
    const a = alert as Record<string, unknown>;
    if (typeof a.status !== "string") return false;
    if (typeof a.fingerprint !== "string") return false;
    if (typeof a.startsAt !== "string") return false;
    if (typeof a.endsAt !== "string") return false;
    if (!a.labels || typeof a.labels !== "object") return false;
    if (!a.annotations || typeof a.annotations !== "object") return false;
  }
  return true;
}

/**
 * §8.1 — first time we see a fingerprint, create an issue. On re-fire, just
 * bump `lastFiredAt` and re-emit the firing event. On re-fire after a manual
 * close, re-open the existing issue (§8.3 option A).
 */
export async function handleFiring(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<void> {
  const stateRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.alert(alert.fingerprint),
  };
  const existing = (await ctx.state.get(stateRef)) as AlertStateRecord | null;
  const nowIso = new Date().toISOString();
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const severity = alert.labels.severity ?? "unknown";

  if (existing && existing.paperclipIssueId) {
    // Re-fire: already have an issue. Refresh body (drill-in URLs may carry
    // a fresh time range) and re-open if a human closed it.
    const newDescription = buildIssueDescription(alert);
    try {
      const issue = await ctx.issues.get(
        existing.paperclipIssueId,
        existing.paperclipCompanyId,
      );
      if (issue && issue.status === "done") {
        await ctx.issues.update(
          existing.paperclipIssueId,
          { status: "todo", description: newDescription },
          existing.paperclipCompanyId,
        );
        await ctx.metrics.write("alertmanager.firing.reopened", 1, {
          alertname,
          severity,
        });
      } else if (issue) {
        await ctx.issues.update(
          existing.paperclipIssueId,
          { description: newDescription },
          existing.paperclipCompanyId,
        );
      }
    } catch (err) {
      ctx.logger.warn(
        `Failed to re-sync existing issue ${existing.paperclipIssueId} on re-fire: ${String(err)}`,
      );
    }

    const updated: AlertStateRecord = {
      ...existing,
      alertname,
      severity,
      lastFiredAt: nowIso,
      resolvedAt: null,
    };
    await ctx.state.set(stateRef, updated);

    await ctx.events.emit(
      "alertmanager.alert.firing",
      existing.paperclipCompanyId,
      {
        fingerprint: alert.fingerprint,
        alertname,
        severity,
        labels: alert.labels,
        annotations: alert.annotations,
        paperclipIssueId: existing.paperclipIssueId,
        assigneeUserId: existing.assigneeUserId,
        assigneeAgentId: existing.assigneeAgentId ?? null,
        reFired: true,
      },
    );
    await ctx.metrics.write("alertmanager.firing.deduped", 1, {
      alertname,
      severity,
    });
    return;
  }

  // First time we've seen this fingerprint — create a new issue.
  const companyId = config.defaultCompanyId;
  if (!companyId) {
    ctx.logger.warn(
      `Cannot create issue for alert ${alert.fingerprint}: defaultCompanyId not configured`,
    );
    return;
  }

  const { assigneeUserId, assigneeAgentId, resolution } =
    await resolveAssigneeUserId(ctx, alert, config.ownerMap);
  const resolvedTarget =
    resolution.agentId
      ? `agent:${resolution.agentId}`
      : resolution.email ?? "(none)";
  const resolvedAssignee =
    assigneeAgentId ?? assigneeUserId ?? "(no assignee)";
  ctx.logger.debug(
    `Owner resolution for ${alertname}: ${resolution.source} → ${resolvedTarget} → ${resolvedAssignee}`,
  );

  const title = buildIssueTitle(alert);
  const description = buildIssueDescription(alert);
  const priority = severityToPriority(severity, config.severityToPriority);

  const billingCode = alert.labels.billing_code ?? null;

  const issue = await ctx.issues.create({
    companyId,
    title,
    description,
    priority,
    originKind: ORIGIN_KIND,
    originId: alert.fingerprint,
    ...(assigneeUserId ? { assigneeUserId } : {}),
    ...(assigneeAgentId ? { assigneeAgentId } : {}),
    ...(billingCode ? { billingCode } : {}),
  });

  const record: AlertStateRecord = {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    assigneeUserId: assigneeUserId ?? null,
    assigneeAgentId: assigneeAgentId ?? null,
    alertname,
    severity,
    firstSeenAt: alert.startsAt || nowIso,
    lastFiredAt: nowIso,
    resolvedAt: null,
  };
  await ctx.state.set(stateRef, record);

  await ctx.events.emit("alertmanager.alert.firing", companyId, {
    fingerprint: alert.fingerprint,
    alertname,
    severity,
    labels: alert.labels,
    annotations: alert.annotations,
    paperclipIssueId: issue.id,
    assigneeUserId: assigneeUserId ?? null,
    assigneeAgentId: assigneeAgentId ?? null,
    reFired: false,
  });

  await ctx.activity.log({
    companyId,
    message: `Alertmanager: created issue for firing alert "${alertname}" (severity=${severity})`,
    entityType: "issue",
    entityId: issue.id,
    metadata: {
      fingerprint: alert.fingerprint,
      assigneeResolutionSource: resolution.source,
    },
  });

  await ctx.metrics.write("alertmanager.firing.handled", 1, {
    alertname,
    severity,
  });
}

/**
 * §8.2 — alert cleared. If we have state for the fingerprint, close or
 * comment per `autoCloseOnResolve`. If not, log and drop.
 */
export async function handleResolved(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<void> {
  const stateRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.alert(alert.fingerprint),
  };
  const existing = (await ctx.state.get(stateRef)) as AlertStateRecord | null;
  if (!existing) {
    ctx.logger.info(
      `Alertmanager: resolved for unknown fingerprint ${alert.fingerprint}, dropping`,
    );
    return;
  }

  const resolvedAt = alert.endsAt || new Date().toISOString();
  const alertname = existing.alertname;

  try {
    if (config.autoCloseOnResolve) {
      await ctx.issues.update(
        existing.paperclipIssueId,
        { status: "done" },
        existing.paperclipCompanyId,
      );
    } else {
      await ctx.issues.createComment(
        existing.paperclipIssueId,
        `Alert resolved at ${resolvedAt}.`,
        existing.paperclipCompanyId,
      );
    }
  } catch (err) {
    ctx.logger.warn(
      `Failed to apply resolution to issue ${existing.paperclipIssueId}: ${String(err)}`,
    );
  }

  const updated: AlertStateRecord = { ...existing, resolvedAt };
  await ctx.state.set(stateRef, updated);

  await ctx.events.emit(
    "alertmanager.alert.resolved",
    existing.paperclipCompanyId,
    {
      fingerprint: alert.fingerprint,
      alertname,
      paperclipIssueId: existing.paperclipIssueId,
      resolvedAt,
    },
  );

  await ctx.metrics.write("alertmanager.resolved.handled", 1, {
    alertname,
    severity: existing.severity,
  });
}

/**
 * Top-level webhook handler. Pure-ish: takes ctx + config + token + input,
 * returns void. Throws `WebhookUnauthorizedError` when the bearer token
 * fails verification — the worker's onWebhook re-throws this so the host
 * can surface a 401 / drop the delivery.
 */
export async function handleWebhook(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  resolvedToken: string | null,
  input: PluginWebhookInput,
): Promise<void> {
  if (input.endpointKey !== WEBHOOK_KEYS.alertmanager) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: ignoring webhook for unknown endpoint key "${input.endpointKey}"`,
    );
    return;
  }

  if (!verifyBearerToken(input.headers, resolvedToken)) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: rejecting webhook — bearer token missing or invalid",
    );
    await ctx.metrics.write("alertmanager.webhook.unauthorized", 1);
    throw new WebhookUnauthorizedError();
  }

  const body = input.parsedBody;
  if (!isAlertmanagerPayload(body)) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: dropping webhook with malformed body",
    );
    await ctx.metrics.write("alertmanager.webhook.malformed", 1);
    return;
  }

  if (!ACCEPTED_SCHEMA_VERSIONS.has(body.version)) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: dropping webhook with unsupported schema version "${body.version}"`,
    );
    await ctx.metrics.write("alertmanager.webhook.unsupported_version", 1, {
      version: body.version,
    });
    return;
  }

  for (const alert of body.alerts) {
    if (!alertMatchesLabelFilter(alert, config.acceptOnlyLabels)) {
      await ctx.metrics.write("alertmanager.webhook.filtered", 1, {
        alertname: alert.labels.alertname ?? "unknown",
      });
      continue;
    }

    const status = effectiveAlertStatus(alert, body);
    try {
      if (status === "firing") {
        await handleFiring(ctx, config, alert);
      } else if (status === "resolved") {
        await handleResolved(ctx, config, alert);
      } else {
        ctx.logger.warn(
          `paperclip-plugin-alertmanager: unknown alert status "${status}" for fingerprint ${alert.fingerprint}`,
        );
      }
    } catch (err) {
      // Spec §5.2 step 3: log + 200 on schema mismatch; same principle
      // here — don't let a single bad alert poison the whole batch.
      ctx.logger.error(
        `paperclip-plugin-alertmanager: error processing alert ${alert.fingerprint}: ${String(err)}`,
      );
      await ctx.metrics.write("alertmanager.alert.error", 1, {
        alertname: alert.labels.alertname ?? "unknown",
      });
    }
  }
}
