import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fingerprint, type Config, type Message } from "./config.js";
import type { Entry, Store } from "./store.js";

export const ORIGIN = "plugin:paperclipai.plugin-slack-control" as const;
export interface Transport {
  verifyDirectMessage(message: Message): Promise<boolean>;
  reply(message: Message, text: string): Promise<void>;
}
const help = "Use status, or new <project alias>: <brief>. Reply in a task's Slack thread to add a follow-up. Approvals remain in Paperclip.";
export function createControl(ctx: PluginContext, companyId: string, config: Config, store: Store, transport: Transport, current: () => boolean) {
  const configDigest = fingerprint(config);
  let draining = false;
  async function identity(message: Message): Promise<string> {
    if (!current() || message.workspaceId !== config.workspaceId) throw new Error("Configuration changed");
    const mapping = config.users.find((user) => user.slackUserId === message.userId);
    const members = await ctx.access.members.list({ companyId });
    if (!mapping || !members.some((member) => member.companyId === companyId && member.principalType === "user" && member.principalId === mapping.boardUserId && member.status === "active" && ["owner", "admin", "operator", "member"].includes(member.membershipRole ?? ""))) throw new Error("Unverified company operator");
    if (!await transport.verifyDirectMessage(message)) throw new Error("Not an authorised direct message");
    if (!current()) throw new Error("Configuration changed");
    return mapping.boardUserId;
  }
  async function finish(entry: Entry, text: string, issueId?: string) {
    // Persist completion before sending: an ambiguous Slack send is never replayed.
    await store.finish(entry.eventKey, "done", text.slice(0, 500), issueId);
    if (current()) {
      try { await transport.reply(entry.message, text.slice(0, 3500)); }
      catch { ctx.logger.warn("Slack acknowledgement could not be confirmed; task delivery remains recorded."); }
    }
  }
  async function process(entry: Entry, fresh: boolean) {
    const message = entry.message;
    if (entry.configDigest !== configDigest) { await store.finish(entry.eventKey, "uncertain", "Configuration changed; operator review required."); return; }
    const userId = await identity(message);
    const binding = await store.binding(message);
    if (binding && (binding.slackUserId !== message.userId || binding.boardUserId !== userId)) throw new Error("Thread identity mismatch");
    const isReply = message.threadTs !== null && message.threadTs !== message.ts;
    if (binding && isReply) {
      const issue = await ctx.issues.get(binding.issueId, companyId);
      if (!issue || !config.projects.some((project) => project.projectId === issue.projectId)) throw new Error("Task no longer in configured scope");
      if (message.text.toLowerCase() === "status") { await finish(entry, `${issue.identifier ?? issue.id}: ${issue.status} — ${issue.title}`, issue.id); return; }
      const marker = `[Slack event ${entry.eventKey}]`;
      if (!fresh) {
        const comments = await ctx.issues.listComments(issue.id, companyId);
        if (comments.some((comment) => comment.authorUserId === userId && comment.body.endsWith(marker))) await finish(entry, "Follow-up recorded in Paperclip.", issue.id);
        else await store.finish(entry.eventKey, "uncertain", "Comment outcome unknown; review before sending a new command.", issue.id);
        return;
      }
      if (!current()) throw new Error("Configuration changed");
      await ctx.issues.createComment(issue.id, `${message.text}\n\n${marker}`, companyId, { actorUserId: userId });
      await finish(entry, "Follow-up recorded in Paperclip. Its normal assignment and approval rules apply.", issue.id);
      return;
    }
    if (isReply) { await finish(entry, "This thread is not bound to a task. Start a new direct message with new <project alias>: <brief>."); return; }
    if (message.text.toLowerCase() === "status") {
      const lines: string[] = [];
      for (const project of config.projects) {
        const issues = await ctx.issues.list({ companyId, projectId: project.projectId, limit: 3 });
        lines.push(`${project.alias}: ${issues.length ? issues.map((issue) => `${issue.identifier ?? issue.id} ${issue.status}`).join(", ") : "no tasks"}`);
      }
      await finish(entry, lines.join("\n")); return;
    }
    const command = /^new ([a-z][a-z0-9-]{0,31}):\s*([\s\S]+)$/.exec(message.text);
    if (!command) { await finish(entry, help); return; }
    const project = config.projects.find((item) => item.alias === command[1]);
    if (!project) { await finish(entry, `Unknown project alias. Available: ${config.projects.map((item) => item.alias).join(", ")}.`); return; }
    const [existingProject, agent] = await Promise.all([ctx.projects.get(project.projectId, companyId), ctx.agents.get(project.agentId, companyId)]);
    if (!existingProject || !agent || agent.status === "terminated" || agent.status === "pending_approval") throw new Error("Configured task destination is unavailable");
    const existing = await ctx.issues.list({ companyId, originKind: ORIGIN, originId: entry.eventKey, limit: 2 });
    if (existing.length > 1) throw new Error("Ambiguous task origin");
    let issue = existing[0];
    if (issue && (issue.companyId !== companyId || issue.projectId !== project.projectId || issue.createdByUserId !== userId)) throw new Error("Task origin scope mismatch");
    if (!issue && !fresh) { await store.finish(entry.eventKey, "uncertain", "Task creation outcome unknown; review the origin before sending a new command."); return; }
    if (!issue) {
      if (!current()) throw new Error("Configuration changed");
      issue = await ctx.issues.create({ companyId, projectId: project.projectId, assigneeAgentId: project.agentId,
        title: command[2]!.trim().slice(0, 120), description: command[2]!.trim(), status: "todo", priority: "medium",
        originKind: ORIGIN, originId: entry.eventKey, actor: { actorUserId: userId },
      });
    }
    await store.bind(message, { slackUserId: message.userId, boardUserId: userId, issueId: issue.id });
    let wakeNotice = "";
    if (current()) {
      try { await ctx.issues.requestWakeup(issue.id, companyId, { actorUserId: userId, idempotencyKey: entry.eventKey, reason: "slack_control", contextSource: "slack_control" }); }
      catch { wakeNotice = "\nThe task was recorded, but its wake was not confirmed. Check assignment, limits and approvals in Paperclip."; }
    }
    await finish(entry, `${issue.identifier ?? issue.id}: ${issue.title}\nReply in this Slack thread to follow up. Approvals remain in Paperclip.${wakeNotice}`, issue.id);
  }
  return {
    async enqueue(message: Message) { await store.enqueue(message, configDigest); },
    async drain() {
      if (draining || !current()) return;
      draining = true;
      try {
        for (const entry of await store.pending()) {
          if (!current()) break;
          const fresh = entry.phase === "received";
          if (fresh && !await store.claim(entry.eventKey)) continue;
          try { await process(entry, fresh); }
          catch { await store.finish(entry.eventKey, "uncertain", "Delivery requires operator review; the command was not replayed."); }
        }
      } finally { draining = false; }
    },
  };
}
