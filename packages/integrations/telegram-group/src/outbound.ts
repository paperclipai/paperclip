import type { Bot } from "grammy";
import type { BindingStore } from "./bindings.js";
import type { TopicBindingStore } from "./state.js";
import type { IssueRef, IssueStatus, PlatformIssueEvent, TelegramGroupBinding } from "./types.js";

export interface IssueTreeResolver {
  findRoot(issueId: string): Promise<IssueRef>;
}

export interface ScrubFn {
  (text: string): string;
}

export interface OutboundDeps {
  bindings: BindingStore;
  topics: TopicBindingStore;
  issues: IssueTreeResolver;
  botForBinding: (binding: TelegramGroupBinding) => Bot;
  scrub?: ScrubFn;
  now?: () => string;
}

export class OutboundPoster {
  constructor(private readonly deps: OutboundDeps) {}

  async handle(event: PlatformIssueEvent): Promise<void> {
    const binding = await this.resolveBinding(event.issue);
    if (!binding || binding.status !== "active") return;

    const root = await this.deps.issues.findRoot(event.issue.id);
    const topic = await this.ensureTopic(binding, root);
    const text = this.render(event, binding);
    const bot = this.deps.botForBinding(binding);
    await bot.api.sendMessage(binding.chatId, text, {
      message_thread_id: topic.messageThreadId,
    });

    if (event.type === "issue.status_changed" && event.issue.id === root.id) {
      await this.deps.topics.updateStatusSnapshot(root.id, event.to);
    }
  }

  private async resolveBinding(issue: IssueRef): Promise<TelegramGroupBinding | null> {
    const { bindings } = this.deps;
    if (issue.projectId) {
      const byProject = await bindings.getActiveForScope(issue.companyId, {
        kind: "project",
        projectId: issue.projectId,
      });
      if (byProject) return byProject;
    }
    if (issue.goalId) {
      const byGoal = await bindings.getActiveForScope(issue.companyId, { kind: "goal", goalId: issue.goalId });
      if (byGoal) return byGoal;
    }
    return bindings.getActiveForScope(issue.companyId, { kind: "company" });
  }

  private async ensureTopic(
    binding: TelegramGroupBinding,
    root: IssueRef,
  ): Promise<{ messageThreadId: number }> {
    const existing = await this.deps.topics.getByIssueId(root.id);
    if (existing) return existing;
    const bot = this.deps.botForBinding(binding);
    const created = await bot.api.createForumTopic(binding.chatId, topicName(root), {
      icon_color: iconColor(root.status),
    });
    const now = (this.deps.now ?? (() => new Date().toISOString()))();
    const topic = {
      issueId: root.id,
      chatId: binding.chatId,
      messageThreadId: created.message_thread_id,
      createdAt: now,
      lastSyncedAt: now,
      statusSnapshot: root.status,
    };
    await this.deps.topics.upsert(topic);
    return topic;
  }

  private render(event: PlatformIssueEvent, binding: TelegramGroupBinding): string {
    const maybeScrub = (s: string): string =>
      binding.redactInternalIds && this.deps.scrub ? this.deps.scrub(s) : s;
    const id = event.issue.identifier;
    switch (event.type) {
      case "issue.created":
        return maybeScrub(`${id} · [new issue] ${event.issue.title} · priority: ${event.issue.priority}`);
      case "issue.status_changed":
        return maybeScrub(`${id} · status: ${event.to} (by ${event.actorLabel})`);
      case "issue.comment_created":
        return maybeScrub(`${id} · comment by ${event.actorLabel}:\n${event.body}`);
      case "issue.assignee_changed":
        return maybeScrub(`${id} · assigned to ${event.toLabel}`);
    }
  }
}

function topicName(root: IssueRef): string {
  const cap = 64;
  const raw = `${root.identifier} · ${root.title}`;
  return raw.length > cap ? raw.slice(0, cap - 1) + "…" : raw;
}

type TopicIconColor = 7322096 | 16766590 | 13338331 | 9367192 | 16749490 | 16478047;

function iconColor(status: IssueStatus): TopicIconColor {
  switch (status) {
    case "in_progress":
      return 9367192;
    case "in_review":
      return 16766590;
    case "blocked":
      return 16478047;
    case "done":
      return 13338331;
    case "cancelled":
      return 16749490;
    default:
      return 7322096;
  }
}
