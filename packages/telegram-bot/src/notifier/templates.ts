import type {
  AgentRef,
  ApprovalRef,
  CommentRef,
  InteractionRef,
  IssueRef,
} from "./types.js";

const SHORT = 200;

export function truncate(s: string | null | undefined, n: number = SHORT): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  return `${flat.slice(0, n - 1).trimEnd()}…`;
}

function ident(issue: IssueRef): string {
  return issue.identifier ? `[${issue.identifier}]` : `[${issue.id.slice(0, 8)}]`;
}

function agentLabel(agent: AgentRef | null | undefined): string {
  if (!agent) return "agent";
  return agent.displayName?.trim() || agent.role?.trim() || agent.id.slice(0, 8);
}

export function renderInteraction(
  issue: IssueRef,
  interaction: InteractionRef,
  agent: AgentRef | null | undefined,
): string {
  const head = `🔔 ${ident(issue)} ${truncate(issue.title, 120)}`;
  const ask = `${agentLabel(agent)} просит: ${truncate(interaction.title, 140)}`;
  const body = truncate(interaction.summary, SHORT);
  const lines = [head, ask];
  if (body) lines.push(body);
  lines.push("Reply на это сообщение → коммент в issue.");
  return lines.join("\n");
}

export function renderApproval(approval: ApprovalRef): string {
  const title = approval.payload?.title?.trim() || `approval ${approval.id.slice(0, 8)}`;
  const summary = truncate(approval.payload?.summary, SHORT);
  const action = approval.payload?.recommendedAction?.trim();
  const lines = [`✋ Approval needed: ${truncate(title, 140)}`];
  if (summary) lines.push(summary);
  if (action) lines.push(`Recommended: ${truncate(action, SHORT)}`);
  lines.push(`Команда: /approve ${approval.id} или /deny ${approval.id}`);
  return lines.join("\n");
}

export function renderBlocked(issue: IssueRef, unblockAction?: string | null): string {
  const action = unblockAction?.trim() || "проверь зависимости и сними блок.";
  return [
    `🚧 ${ident(issue)} ${truncate(issue.title, 140)}`,
    "Заблокирована, unblock owner = ты.",
    `Действие: ${truncate(action, SHORT)}`,
  ].join("\n");
}

export function renderDone(
  issue: IssueRef,
  agent: AgentRef | null | undefined,
  lastComment: CommentRef | null | undefined,
): string {
  const tail = truncate(lastComment?.body, SHORT);
  const lines = [
    `✅ ${ident(issue)} ${truncate(issue.title, 140)}`,
    `Ассигни: ${agentLabel(agent)}`,
  ];
  if (tail) lines.push(`Итог: ${tail}`);
  return lines.join("\n");
}

const TG_HARD_LIMIT = 4096;
const DIGEST_HEADER = "📊 Weekly Board Digest";

export function renderWeeklyDigest(
  issue: IssueRef,
  comment: CommentRef | null | undefined,
): string {
  const body = comment?.body?.trim() ?? "";
  const link = `https://paperclip.thethirdchair.ru/THE/issues/${issue.identifier ?? issue.id}`;
  const footer = `\n\n📄 Источник: ${link}`;
  const header = `${DIGEST_HEADER}\n\n`;
  const room = TG_HARD_LIMIT - header.length - footer.length;
  let payload = body;
  if (payload.length > room) {
    payload = `${payload.slice(0, room - 1).trimEnd()}…`;
  }
  return `${header}${payload}${footer}`;
}
