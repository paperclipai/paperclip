import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { parseConfig, type NotifierConfig } from "./config.js";
import { DecisionDedupe } from "./dedupe.js";
import { buildClickUrl, buildMessageBody, buildMessageTitle, buildPublishUrl, MESSAGE_TAGS, type MessageTarget } from "./message.js";
import { sendNtfy, type FetchLike } from "./ntfy.js";
import {
  BLOCKER_ATTENTION_CHANGED,
  blockerDecisionKey,
  blockerTreeEpisodeKey,
  classifyEvent,
  interactionRouting,
  isHumanOwnedBlocker,
  type DecisionCandidate,
  type InteractionRouting,
  type IssueBlockerView,
} from "./triggers.js";

export interface NotifierOptions {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Override for tests; defaults to the host-mediated `ctx.http.fetch`. */
  fetch?: FetchLike;
}

interface ResolvedDecision {
  key: string;
  issue: { identifier?: string | null } | null;
  /** `once` (default): one push per key. `episode`: one push per open feed episode. `close`: end the episode. */
  mode?: "once" | "episode" | "close";
}

export const DEFAULT_NOTIFIER_OPTIONS: NotifierOptions = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  retryDelayMs: 500,
};

export type NotifyOutcome =
  | "ignored"
  | "not_configured"
  | "not_eligible"
  | "addressee_unknown"
  | "episode_closed"
  | "duplicate"
  | "sent"
  | "send_failed"
  | "token_unavailable"
  | "error";

/**
 * Handles one host event end to end. Never throws: an event handler failure
 * must not affect the host or other plugins. Log lines carry only coarse
 * outcome codes, never identifiers, URLs, tokens or event text.
 */
export class DecisionNotifier {
  private readonly dedupe: DecisionDedupe;
  /** Tail of the handler chain per company and feed key; see `handle`. */
  private readonly feedQueue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly options: NotifierOptions = DEFAULT_NOTIFIER_OPTIONS,
  ) {
    this.dedupe = new DecisionDedupe(ctx.state);
  }

  /**
   * Feed events (computed blocker attention) for one company and feed key are
   * handled strictly in arrival order, from handler entry, before any
   * asynchronous wait (configuration, issue lookup, send). Without this an exit
   * could finish while the matching entry still waits on its issue lookup,
   * close nothing, and let the late entry leave an open episode that hides the
   * next legitimate entry. The host forwards events without awaiting handlers,
   * so they can overlap. Events for other keys, and all other event kinds, are
   * not queued and run independently.
   */
  handle(event: PluginEvent): Promise<NotifyOutcome> {
    const orderKey = feedOrderKey(event);
    if (orderKey === null) return this.process(event);
    const previous = this.feedQueue.get(orderKey) ?? Promise.resolve();
    const run = () => this.process(event);
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.feedQueue.set(orderKey, tail);
    void tail.then(() => {
      if (this.feedQueue.get(orderKey) === tail) this.feedQueue.delete(orderKey);
    });
    return result;
  }

  private async process(event: PluginEvent): Promise<NotifyOutcome> {
    let kind: DecisionCandidate["kind"] | "unknown" = "unknown";
    try {
      const config = await this.loadConfig(event.companyId);
      if (!config) return "not_configured";

      const candidate = classifyEvent(event, config.triggers);
      if (!candidate) return "ignored";
      kind = candidate.kind;

      const decision = await this.resolveDecisionKey(candidate);
      if (decision === "addressee_unknown") return this.log(kind, "addressee_unknown");
      if (!decision) return this.log(kind, "not_eligible");
      const key = { companyId: candidate.companyId, key: decision.key };
      if (decision.mode === "close") {
        await this.dedupe.closeEpisode(key);
        return this.log(kind, "episode_closed");
      }

      let sendOutcome: NotifyOutcome = "send_failed";
      const send = async () => {
        sendOutcome = await this.send(config, candidate, decision.issue);
        return sendOutcome === "sent";
      };
      const result = decision.mode === "episode" ? await this.dedupe.runEpisode(key, send) : await this.dedupe.runOnce(key, send);
      if (result === "duplicate") return this.log(kind, "duplicate");
      return this.log(kind, sendOutcome);
    } catch (error) {
      // Only the error class name is logged: messages can embed URLs.
      this.ctx.logger.warn("ntfy notifier: event handling failed", {
        kind,
        outcome: "error",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return "error";
    }
  }

  private log(kind: string, outcome: NotifyOutcome): NotifyOutcome {
    const meta = { kind, outcome };
    if (outcome === "sent") this.ctx.logger.info("ntfy notifier: decision notification sent", meta);
    else if (outcome === "send_failed" || outcome === "token_unavailable" || outcome === "addressee_unknown") {
      this.ctx.logger.warn("ntfy notifier: decision notification not sent", meta);
    } else this.ctx.logger.debug("ntfy notifier: decision skipped", meta);
    return outcome;
  }

  private async loadConfig(companyId: string): Promise<NotifierConfig | null> {
    const raw = await this.ctx.config.get(companyId);
    if (!raw || Object.keys(raw).length === 0) return null;
    const parsed = parseConfig(raw);
    if (!parsed.ok) {
      this.ctx.logger.warn("ntfy notifier: config is invalid; notifications are off", {
        errorCount: parsed.errors.length,
      });
      return null;
    }
    return parsed.config;
  }

  private async resolveDecisionKey(
    candidate: DecisionCandidate,
  ): Promise<ResolvedDecision | "addressee_unknown" | null> {
    switch (candidate.kind) {
      case "approval":
        return {
          key: candidate.toolActionRequestId
            ? `tool-action:${candidate.toolActionRequestId}`
            : `approval:${candidate.approvalId}`,
          issue: null,
        };
      case "interaction": {
        if (candidate.routing === "unknown") {
          const routing = await this.resolveInteractionRouting(candidate);
          if (routing === "unknown") return "addressee_unknown";
          if (routing !== "human") return null;
        }
        return {
          key: candidate.toolActionRequestId
            ? `tool-action:${candidate.toolActionRequestId}`
            : `interaction:${candidate.interactionId}`,
          issue: null,
        };
      }
      case "blocker": {
        const issue = (await this.ctx.issues.get(candidate.issueId, candidate.companyId)) as
          | (IssueBlockerView & { identifier?: string | null })
          | null;
        // An issue the plugin may not read cannot be confirmed as human-owned.
        if (!issue || !isHumanOwnedBlocker(issue)) return null;
        return { key: blockerDecisionKey(candidate.issueId, issue), issue };
      }
      case "blocker_tree": {
        const episode = blockerTreeEpisodeKey(candidate.dedupKey);
        if (candidate.phase === "exit") return { key: episode, issue: null, mode: "close" };
        // The feed item's subject is its terminal blocker (`blocker:<issueId>`). When that terminal
        // issue is itself blocked with a human-owned unblock step, the item is the same decision as
        // the human-owned blocked push (the feed also lists it as `blocked-owner:`), so it shares the
        // human-owned key and gets one push. This depends only on the terminal issue, never on which
        // downstream issue the host chose as `blockedIssueId` (the group's most recently updated one).
        const terminal = (await this.ctx.issues.get(candidate.issueId, candidate.companyId).catch(() => null)) as
          | (IssueBlockerView & { identifier?: string | null })
          | null;
        if (terminal && isHumanOwnedBlocker(terminal)) return { key: blockerDecisionKey(candidate.issueId, terminal), issue: terminal };
        return { key: episode, issue: null, mode: "episode" };
      }
      case "decision":
        return { key: `decision:${candidate.decisionId}`, issue: null };
    }
  }

  /**
   * The event did not say who the card is for. Read the card through the
   * supported `issue.interactions.read` capability. If it cannot be read (for
   * example a private issue), the addressee stays unknown and nothing is sent.
   */
  private async resolveInteractionRouting(
    candidate: Extract<DecisionCandidate, { kind: "interaction" }>,
  ): Promise<InteractionRouting> {
    const cards = await this.ctx.issues
      .listInteractions(candidate.issueId, candidate.companyId)
      .catch(() => null);
    const card = cards?.find((entry) => entry.id === candidate.interactionId) as
      | { status?: unknown; addresseeAgentId?: unknown }
      | undefined;
    if (!card) return "unknown";
    return interactionRouting({ interactionStatus: card.status, addresseeAgentId: card.addresseeAgentId ?? null });
  }

  private async target(
    candidate: DecisionCandidate,
    knownIssue: { identifier?: string | null } | null,
  ): Promise<MessageTarget> {
    const company = await this.ctx.companies.get(candidate.companyId).catch(() => null);
    const issueId = candidate.issueId;
    let identifier = knownIssue?.identifier ?? null;
    if (!identifier && issueId) {
      // Private issues the plugin may not read return null; the link then
      // falls back to the issue UUID and the body carries no identifier.
      const issue = await this.ctx.issues.get(issueId, candidate.companyId).catch(() => null);
      identifier = issue?.identifier ?? null;
    }
    return {
      issuePrefix: company?.issuePrefix ?? null,
      issueIdentifier: identifier,
      issueId,
      approvalId: candidate.kind === "approval" ? candidate.approvalId : null,
      decisionId: candidate.kind === "decision" ? candidate.decisionId : null,
      // Only when no issue is linked; an unreadable linked issue keeps the bare sentence.
      fallbackLabel: issueId ? null : candidate.kind === "approval" ? "approval" : candidate.kind === "decision" ? "decision" : null,
    };
  }

  private async send(
    config: NotifierConfig,
    candidate: DecisionCandidate,
    knownIssue: { identifier?: string | null } | null,
  ): Promise<NotifyOutcome> {
    let token: string | undefined;
    if (config.tokenSecretRef) {
      try {
        token = await this.ctx.secrets.resolve(config.tokenSecretRef as never);
      } catch {
        return "token_unavailable";
      }
      if (!token) return "token_unavailable";
    }
    const target = await this.target(candidate, knownIssue);
    const result = await sendNtfy(
      {
        url: buildPublishUrl(config.ntfyBaseUrl, config.topic),
        body: buildMessageBody(target),
        click: buildClickUrl(config.paperclipBaseUrl, target),
        title: buildMessageTitle(target),
        tags: MESSAGE_TAGS,
        token,
        priority: config.priority ?? undefined,
      },
      {
        fetch: this.options.fetch ?? ((url, init) => this.ctx.http.fetch(url, init)),
        timeoutMs: this.options.timeoutMs,
        maxAttempts: this.options.maxAttempts,
        retryDelayMs: this.options.retryDelayMs,
        sleep: this.options.sleep,
      },
    );
    if (!result.ok) {
      this.ctx.logger.warn("ntfy notifier: publish failed", {
        kind: candidate.kind,
        reason: result.reason,
        status: result.status ?? null,
        attempts: result.attempts,
      });
      return "send_failed";
    }
    return "sent";
  }
}

/**
 * Synchronous ordering key for a computed blocker attention event: company and
 * the feed's raw `dedupKey`. Read before any await so that arrival order is
 * kept. Other events return `null` and are not ordered.
 */
function feedOrderKey(event: PluginEvent): string | null {
  if ((event.eventType as string) !== BLOCKER_ATTENTION_CHANGED) return null;
  const payload = event.payload as { dedupKey?: unknown } | null | undefined;
  const dedupKey = payload && typeof payload === "object" ? payload.dedupKey : undefined;
  if (typeof dedupKey !== "string" || dedupKey.length === 0) return null;
  return `${event.companyId}\u0000${dedupKey}`;
}
