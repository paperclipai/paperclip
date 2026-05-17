/**
 * Phase 4A-S4 B2 (LET-367): notifier abstraction for cap breach + operator
 * toggle audit events.
 *
 * The monitor knows nothing about Telegram, Slack, or Paperclip comments. It
 * hands `CapNotification` objects to a `CapNotifier`. The default registered
 * notifier is a composite of:
 *   - `LogNotifier` — always on, writes a structured log line at the
 *     appropriate level.
 *   - `PaperclipCommentNotifier` — optional, posts an issue comment when the
 *     monitor wants operator visibility. Requires `parentIssueId` + an
 *     `addComment` callback the caller wires from `issuesSvc.addComment`.
 *   - `TelegramNotifier` — optional, ships a one-line page on hard caps. When
 *     no Telegram credentials are present, the constructor returns a no-op so
 *     the production deployment is unaffected.
 *
 * Hard invariant: notification payloads are pre-redacted by the monitor. The
 * notifier MUST NOT introspect or re-serialise raw lease metadata or vendor
 * responses; it only forwards what it was given.
 */

import type { Logger } from "pino";

export type CapNotificationTone = "warning" | "danger" | "info";
export type CapNotificationKind =
  | "soft_cap_breached"
  | "hard_cap_breached"
  | "operator_toggle_flipped"
  | "monthly_incident_opened"
  | "auto_disable_engaged"
  | "reenable_refused";

export interface CapNotification {
  companyId: string;
  provider: string;
  kind: CapNotificationKind;
  tone: CapNotificationTone;
  /**
   * Title text safe for surfacing in an operator UI / comment.
   * No raw vendor credential ever appears here.
   */
  title: string;
  /** Long-form body text; markdown-safe. Pre-redacted. */
  body: string;
  /**
   * When `true`, hard-cap interrupt semantics apply: notifier-side surfaces
   * (comments, paging) should treat this as an interrupt.
   */
  interrupt?: boolean;
  /** Structured metadata for log lines / event payloads. Already redacted. */
  metadata?: Record<string, unknown>;
}

export interface CapNotifier {
  notify(notification: CapNotification): Promise<void>;
}

export class NoopCapNotifier implements CapNotifier {
  async notify(_notification: CapNotification): Promise<void> {
    /* intentional no-op */
  }
}

export class LogCapNotifier implements CapNotifier {
  constructor(private readonly logger: Pick<Logger, "info" | "warn" | "error">) {}
  async notify(notification: CapNotification): Promise<void> {
    const payload = {
      companyId: notification.companyId,
      provider: notification.provider,
      kind: notification.kind,
      tone: notification.tone,
      interrupt: notification.interrupt === true,
      metadata: notification.metadata ?? null,
      title: notification.title,
    };
    if (notification.tone === "danger") {
      this.logger.error(payload, notification.title);
    } else if (notification.tone === "warning") {
      this.logger.warn(payload, notification.title);
    } else {
      this.logger.info(payload, notification.title);
    }
  }
}

export interface PaperclipCommentTransport {
  /**
   * Post a Paperclip comment. Caller wires this to `issuesSvc.addComment` so
   * the notifier never imports the issues service directly (keeps this module
   * test-friendly and dependency-light).
   */
  addComment(
    issueId: string,
    body: string,
    opts: { tone: CapNotificationTone; interrupt: boolean },
  ): Promise<void>;
}

export class PaperclipCommentCapNotifier implements CapNotifier {
  constructor(
    private readonly transport: PaperclipCommentTransport,
    private readonly resolveIssueId: (notification: CapNotification) => string | null,
  ) {}
  async notify(notification: CapNotification): Promise<void> {
    const issueId = this.resolveIssueId(notification);
    if (!issueId) return;
    const body =
      `**${notification.title}**\n\n${notification.body}\n\n` +
      `_Posted by E2B sandbox cap monitor — kind=${notification.kind}, tone=${notification.tone}_`;
    await this.transport.addComment(issueId, body, {
      tone: notification.tone,
      interrupt: notification.interrupt === true,
    });
  }
}

export interface TelegramTransport {
  /** Sends a one-line page; rate-limiting / retry is the transport's concern. */
  sendPage(message: string): Promise<void>;
}

export class TelegramCapNotifier implements CapNotifier {
  constructor(private readonly transport: TelegramTransport) {}
  async notify(notification: CapNotification): Promise<void> {
    if (notification.tone !== "danger" && notification.kind !== "monthly_incident_opened") {
      // Telegram pages are reserved for danger-tone (hard caps) and monthly
      // incidents. Soft caps stay in comments + logs.
      return;
    }
    const interruptMark = notification.interrupt ? "🚨 " : "";
    const message = `${interruptMark}[E2B cap monitor] ${notification.title}`;
    await this.transport.sendPage(message);
  }
}

export class CompositeCapNotifier implements CapNotifier {
  constructor(private readonly notifiers: CapNotifier[]) {}
  async notify(notification: CapNotification): Promise<void> {
    const results = await Promise.allSettled(
      this.notifiers.map((notifier) => notifier.notify(notification)),
    );
    // Aggregate rejections into a single thrown error so callers see the
    // first failure without losing visibility into the rest.
    const failures = results.flatMap((res) => (res.status === "rejected" ? [res.reason] : []));
    if (failures.length > 0) {
      const err = failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
      err.message = `Cap notifier composite failed (${failures.length}): ${err.message}`;
      throw err;
    }
  }
}
