import type { ReplyStore } from "../state/reply-store.js";
import type { NotifierApi } from "./api.js";
import type { NotifierDedup } from "./dedup.js";
import type {
  AgentRef,
  ApprovalRef,
  InteractionRef,
  IssueRef,
  NotifierEventType,
  RenderedEvent,
} from "./types.js";
import {
  approvalIsForUser,
  interactionIsForUser,
  issueIsOwnedByUser,
} from "./filters.js";
import {
  renderApproval,
  renderBlocked,
  renderDone,
  renderInteraction,
} from "./templates.js";

export type TgSendResult = { message_id: number };

export type TgSender = (chatId: string, text: string) => Promise<TgSendResult>;

export type Logger = {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
};

export type NotifierMetrics = {
  eventsSent: (type: NotifierEventType) => void;
  pollError: (type: NotifierEventType | "tick") => void;
};

const NOOP_METRICS: NotifierMetrics = {
  eventsSent: () => {},
  pollError: () => {},
};

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export type NotifierPollerOptions = {
  api: NotifierApi;
  dedup: NotifierDedup;
  replyStore: ReplyStore;
  send: TgSender;
  dinarUserId: string;
  dinarChatId: string;
  intervalMs?: number;
  maxSendAttempts?: number;
  baseSendBackoffMs?: number;
  logger?: Logger;
  metrics?: NotifierMetrics;
  /** Bound on Telegram messages emitted per tick (per-type). Defaults 20. */
  perTypeBatchLimit?: number;
};

export class NotifierPoller {
  private readonly api: NotifierApi;
  private readonly dedup: NotifierDedup;
  private readonly replyStore: ReplyStore;
  private readonly send: TgSender;
  private readonly dinarUserId: string;
  private readonly dinarChatId: string;
  private readonly intervalMs: number;
  private readonly maxSendAttempts: number;
  private readonly baseSendBackoffMs: number;
  private readonly perTypeBatchLimit: number;
  private readonly log: Logger;
  private readonly metrics: NotifierMetrics;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly agentCache = new Map<string, AgentRef | null>();

  constructor(opts: NotifierPollerOptions) {
    this.api = opts.api;
    this.dedup = opts.dedup;
    this.replyStore = opts.replyStore;
    this.send = opts.send;
    this.dinarUserId = opts.dinarUserId;
    this.dinarChatId = opts.dinarChatId;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.maxSendAttempts = opts.maxSendAttempts ?? 4;
    this.baseSendBackoffMs = opts.baseSendBackoffMs ?? 500;
    this.perTypeBatchLimit = opts.perTypeBatchLimit ?? 20;
    this.log = opts.logger ?? NOOP_LOGGER;
    this.metrics = opts.metrics ?? NOOP_METRICS;
  }

  async start(): Promise<void> {
    await this.dedup.load();
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.runTick();
    }, delay);
  }

  private async runTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.metrics.pollError("tick");
      this.log.error("notifier tick crashed", { err: String(err) });
    } finally {
      this.scheduleNext(this.intervalMs);
    }
  }

  /** Run exactly one poll cycle. Exposed for tests. */
  async tick(): Promise<{ sent: number; skipped: number; errors: number }> {
    await this.dedup.load();
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    this.agentCache.clear();

    const handlers: Array<() => Promise<{ sent: number; skipped: number; errors: number }>> = [
      () => this.pollInteractions(),
      () => this.pollApprovals(),
      () => this.pollBlocked(),
      () => this.pollDone(),
    ];

    for (const run of handlers) {
      try {
        const r = await run();
        sent += r.sent;
        skipped += r.skipped;
        errors += r.errors;
      } catch (err) {
        errors += 1;
        this.log.error("notifier subpoll failed", { err: String(err) });
      }
    }
    try {
      await this.dedup.flush();
    } catch (err) {
      this.log.error("notifier dedup flush failed", { err: String(err) });
    }
    return { sent, skipped, errors };
  }

  private async pollInteractions(): Promise<{ sent: number; skipped: number; errors: number }> {
    let issues: IssueRef[];
    try {
      issues = await this.api.listInReviewIssuesForUser(this.dinarUserId);
    } catch (err) {
      this.metrics.pollError("interaction");
      this.log.warn("interactions list failed", { err: String(err) });
      return { sent: 0, skipped: 0, errors: 1 };
    }
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const issue of issues) {
      if (!issueIsOwnedByUser(issue, this.dinarUserId)) {
        skipped += 1;
        continue;
      }
      let interactions: InteractionRef[] = [];
      try {
        interactions = await this.api.listInteractionsForIssue(issue.id);
      } catch (err) {
        errors += 1;
        this.log.warn("interactions for-issue failed", { issueId: issue.id, err: String(err) });
        continue;
      }
      for (const interaction of interactions) {
        if (!interactionIsForUser(issue, interaction, this.dinarUserId)) {
          skipped += 1;
          continue;
        }
        const dedupKey = `interaction:${interaction.id}`;
        if (this.dedup.has("interaction", dedupKey)) {
          skipped += 1;
          continue;
        }
        const agent = await this.lookupAgent(interaction.createdByAgentId ?? issue.assigneeAgentId ?? null);
        const text = renderInteraction(issue, interaction, agent);
        const ok = await this.deliver({ type: "interaction", dedupKey, issueId: issue.id, text });
        if (ok) {
          sent += 1;
        } else {
          errors += 1;
        }
        if (sent >= this.perTypeBatchLimit) break;
      }
      if (sent >= this.perTypeBatchLimit) break;
    }
    return { sent, skipped, errors };
  }

  private async pollApprovals(): Promise<{ sent: number; skipped: number; errors: number }> {
    let approvals: ApprovalRef[];
    try {
      approvals = await this.api.listPendingApprovals();
    } catch (err) {
      this.metrics.pollError("approval");
      this.log.warn("approvals list failed", { err: String(err) });
      return { sent: 0, skipped: 0, errors: 1 };
    }
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const approval of approvals) {
      if (!approvalIsForUser(approval, this.dinarUserId)) {
        skipped += 1;
        continue;
      }
      const dedupKey = `approval:${approval.id}`;
      if (this.dedup.has("approval", dedupKey)) {
        skipped += 1;
        continue;
      }
      const text = renderApproval(approval);
      const issueId = approval.issueIds?.[0] ?? approval.id;
      const ok = await this.deliver({ type: "approval", dedupKey, issueId, text });
      if (ok) {
        sent += 1;
      } else {
        errors += 1;
      }
      if (sent >= this.perTypeBatchLimit) break;
    }
    return { sent, skipped, errors };
  }

  private async pollBlocked(): Promise<{ sent: number; skipped: number; errors: number }> {
    let issues: IssueRef[];
    try {
      issues = await this.api.listBlockedIssuesForUser(this.dinarUserId);
    } catch (err) {
      this.metrics.pollError("blocked");
      this.log.warn("blocked list failed", { err: String(err) });
      return { sent: 0, skipped: 0, errors: 1 };
    }
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const issue of issues) {
      if (!issueIsOwnedByUser(issue, this.dinarUserId)) {
        skipped += 1;
        continue;
      }
      const dedupKey = `blocked:${issue.id}`;
      if (this.dedup.has("blocked", dedupKey)) {
        skipped += 1;
        continue;
      }
      const text = renderBlocked(issue, extractUnblockAction(issue));
      const ok = await this.deliver({ type: "blocked", dedupKey, issueId: issue.id, text });
      if (ok) {
        sent += 1;
      } else {
        errors += 1;
      }
      if (sent >= this.perTypeBatchLimit) break;
    }
    return { sent, skipped, errors };
  }

  private async pollDone(): Promise<{ sent: number; skipped: number; errors: number }> {
    let issues: IssueRef[];
    try {
      issues = await this.api.listDoneIssuesCreatedBy(this.dinarUserId);
    } catch (err) {
      this.metrics.pollError("done");
      this.log.warn("done list failed", { err: String(err) });
      return { sent: 0, skipped: 0, errors: 1 };
    }
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const issue of issues) {
      if (issue.createdByUserId && issue.createdByUserId !== this.dinarUserId) {
        skipped += 1;
        continue;
      }
      const dedupKey = `done:${issue.id}`;
      if (this.dedup.has("done", dedupKey)) {
        skipped += 1;
        continue;
      }
      const agent = await this.lookupAgent(issue.assigneeAgentId ?? null);
      let lastComment = null;
      try {
        lastComment = await this.api.getLatestComment(issue.id);
      } catch (err) {
        this.log.warn("done last-comment failed", { issueId: issue.id, err: String(err) });
      }
      const text = renderDone(issue, agent, lastComment);
      const ok = await this.deliver({ type: "done", dedupKey, issueId: issue.id, text });
      if (ok) {
        sent += 1;
      } else {
        errors += 1;
      }
      if (sent >= this.perTypeBatchLimit) break;
    }
    return { sent, skipped, errors };
  }

  private async deliver(event: RenderedEvent): Promise<boolean> {
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < this.maxSendAttempts) {
      try {
        const res = await this.send(this.dinarChatId, event.text);
        this.replyStore.remember(this.dinarChatId, res.message_id, { issueId: event.issueId });
        this.dedup.remember(event.type, event.dedupKey);
        this.metrics.eventsSent(event.type);
        return true;
      } catch (err) {
        lastErr = err;
        attempt += 1;
        const wait = this.baseSendBackoffMs * 2 ** (attempt - 1);
        this.log.warn("notifier send retry", {
          attempt,
          type: event.type,
          err: String(err),
        });
        if (attempt < this.maxSendAttempts) {
          await sleep(wait);
        }
      }
    }
    this.log.error("notifier send permanently failed", {
      type: event.type,
      issueId: event.issueId,
      err: String(lastErr),
    });
    return false;
  }

  private async lookupAgent(agentId: string | null): Promise<AgentRef | null> {
    if (!agentId) return null;
    if (this.agentCache.has(agentId)) return this.agentCache.get(agentId) ?? null;
    const agent = await this.api.getAgent(agentId);
    this.agentCache.set(agentId, agent);
    return agent;
  }
}

function extractUnblockAction(issue: IssueRef): string | null {
  const desc = issue.description?.trim();
  if (!desc) return null;
  const match = /unblock owner[^\n]*?:\s*([^\n]+)/i.exec(desc);
  return match ? match[1].trim() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
