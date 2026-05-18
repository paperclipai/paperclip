/**
 * Phase 4A-S4 (LET-392): runtime wiring helpers for the cap notifier
 * composite + the monthly-incident creation hook.
 *
 * `notifier.ts` only defines the in-process notifier classes + transport
 * interfaces. This module is the seam between those abstractions and the
 * real Paperclip issues service / Telegram HTTP transport so app.ts (and
 * tests) can compose the full chain without leaking either dependency into
 * the notifier module.
 *
 * Hard invariants:
 *   - When credentials/env are absent every helper returns a no-op or null
 *     so default deployments are unaffected.
 *   - The monthly-incident hook never throws back into the monitor tick —
 *     failures are caught + logged so a flaky Paperclip API call cannot
 *     bury the breach audit row.
 *   - `addComment`/`create` failures bubble out only through the structured
 *     logger; the composite notifier already aggregates rejections so the
 *     monitor does not crash on a transient Paperclip error.
 */

import type { Logger } from "pino";
import {
  PaperclipCommentCapNotifier,
  TelegramCapNotifier,
  type CapNotification,
  type CapNotifier,
  type PaperclipCommentTransport,
  type TelegramTransport,
} from "./notifier.js";

/**
 * Subset of `issueService(db)` we need to post cap-breach comments. Declared
 * structurally so the test suite can pass a vi.fn() mock without dragging in
 * the full issues service surface.
 */
export interface CapNotifierIssueCommentService {
  addComment(
    issueId: string,
    body: string,
    actor: { agentId?: string; userId?: string; runId?: string | null },
    options?: {
      authorType?: "agent" | "user" | "system" | null;
      presentation?: {
        kind?: "message" | "system_notice";
        tone?: "neutral" | "info" | "success" | "warning" | "danger";
        title?: string | null;
        detailsDefaultOpen?: boolean;
      } | null;
    },
  ): Promise<unknown>;
}

export interface CapNotifierIssueCreateService {
  create(
    companyId: string,
    data: {
      title: string;
      description: string;
      status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
      priority?: "critical" | "high" | "medium" | "low";
      parentId?: string | null;
      projectId?: string | null;
      goalId?: string | null;
      labelIds?: string[];
      originKind?: string;
      originFingerprint?: string;
    },
  ): Promise<{ id: string }>;
  listLabels(companyId: string): Promise<Array<{ id: string; name: string }>>;
  createLabel(companyId: string, data: { name: string; color: string }): Promise<{ id: string }>;
}

export interface CreatePaperclipCommentCapNotifierOptions {
  issuesSvc: CapNotifierIssueCommentService;
  /** Issue UUID receiving cap-breach comments (e.g., the active pilot's parent). */
  pilotIncidentIssueId: string | null;
  /** Comment author agent id (e.g., the auto-cap-monitor system agent). */
  authorAgentId?: string | null;
  /** Run id stamped on the comment audit row (optional). */
  runId?: string | null;
  logger?: Pick<Logger, "warn" | "error">;
}

export function createPaperclipCommentCapNotifier(
  opts: CreatePaperclipCommentCapNotifierOptions,
): CapNotifier {
  const transport: PaperclipCommentTransport = {
    async addComment(issueId, body, postOpts) {
      const tone = postOpts.tone === "info" ? "info" : postOpts.tone;
      await opts.issuesSvc.addComment(
        issueId,
        body,
        { agentId: opts.authorAgentId ?? undefined, runId: opts.runId ?? null },
        {
          authorType: opts.authorAgentId ? "agent" : "system",
          presentation: {
            kind: "system_notice",
            tone,
            title: "Sandbox cost-cap monitor",
          },
        },
      );
    },
  };
  return new PaperclipCommentCapNotifier(transport, (notification: CapNotification) => {
    // AC #3 + LET-392 scope: every cap-breach surface lands on the same
    // pilot-incident issue. When no issue is configured (default deployment)
    // the notifier returns a no-op rather than guessing a target.
    if (notification.kind === "operator_toggle_flipped") {
      // Operator toggle audit lives in activity_log already; skip the comment
      // surface to avoid noise on routine on/off flips.
      return null;
    }
    return opts.pilotIncidentIssueId ?? null;
  });
}

export function createTelegramCapNotifier(transport: TelegramTransport | null): CapNotifier | null {
  if (!transport) return null;
  return new TelegramCapNotifier(transport);
}

export interface CreateMonthlyIncidentHookOptions {
  issuesSvc: CapNotifierIssueCreateService;
  /** Pilot project the incident should land in (carries workspace/policy). */
  resolveProjectId: () => string | null | Promise<string | null>;
  /** Parent issue (LET-365-equivalent) so the incident sits inside the pilot tree. */
  resolveParentIssueId: () => string | null | Promise<string | null>;
  /** Label name surfaced on the issue. Defaults to `sandbox/cost-breach`. */
  labelName?: string;
  /** Default colour used when the label has to be created. */
  labelColor?: string;
  logger?: Pick<Logger, "warn" | "error" | "info">;
}

const DEFAULT_INCIDENT_LABEL_NAME = "sandbox/cost-breach";
const DEFAULT_INCIDENT_LABEL_COLOR = "#dc2626";

export function createOpenMonthlyIncidentHook(
  opts: CreateMonthlyIncidentHookOptions,
): (notification: CapNotification) => Promise<string | null> {
  const labelName = (opts.labelName ?? DEFAULT_INCIDENT_LABEL_NAME).trim();
  const labelColor = opts.labelColor ?? DEFAULT_INCIDENT_LABEL_COLOR;
  return async (notification: CapNotification) => {
    try {
      const [projectId, parentIssueId] = await Promise.all([
        Promise.resolve(opts.resolveProjectId()),
        Promise.resolve(opts.resolveParentIssueId()),
      ]);
      const labelId = await ensureIncidentLabel({
        issuesSvc: opts.issuesSvc,
        companyId: notification.companyId,
        name: labelName,
        color: labelColor,
        logger: opts.logger,
      });
      const created = await opts.issuesSvc.create(notification.companyId, {
        title: "[INCIDENT] Sandbox cost-breach — E2B monthly hard cap",
        description: buildIncidentDescription(notification),
        status: "todo",
        priority: "high",
        parentId: parentIssueId ?? null,
        projectId: projectId ?? null,
        labelIds: labelId ? [labelId] : [],
        originKind: "sandbox_cost_breach_incident",
        originFingerprint: `sandbox-cost-breach:${notification.companyId}:${notification.provider}`,
      });
      return created.id ?? null;
    } catch (err) {
      opts.logger?.error(
        { err, companyId: notification.companyId },
        "sandbox billing-cap monthly-incident hook failed",
      );
      return null;
    }
  };
}

async function ensureIncidentLabel(input: {
  issuesSvc: CapNotifierIssueCreateService;
  companyId: string;
  name: string;
  color: string;
  logger?: Pick<Logger, "warn" | "error">;
}): Promise<string | null> {
  try {
    const existing = await input.issuesSvc.listLabels(input.companyId);
    const match = existing.find((row) => row.name === input.name);
    if (match) return match.id;
    const created = await input.issuesSvc.createLabel(input.companyId, {
      name: input.name,
      color: input.color,
    });
    return created.id;
  } catch (err) {
    input.logger?.warn(
      { err, companyId: input.companyId, label: input.name },
      "sandbox billing-cap incident label resolution failed; creating issue without label",
    );
    return null;
  }
}

function buildIncidentDescription(notification: CapNotification): string {
  return [
    notification.body,
    "",
    "_Auto-opened by the E2B billing-cap monitor on a monthly hard-cap breach._",
    `_kind=${notification.kind}, tone=${notification.tone}, interrupt=${notification.interrupt === true}_`,
    "",
    "Required follow-up (manual):",
    "- Acknowledge breach with Andrii.",
    "- Investigate root cause + post cost-cause note.",
    "- Re-enable requires a fresh request_confirmation after the new UTC month.",
  ].join("\n");
}
