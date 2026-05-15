#!/usr/bin/env -S node --import tsx

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = process.env.JEFF_TELEGRAM_CHAT_ID || process.env.CHAT_ID;
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

const COOLDOWN_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 1100;
const API_TIMEOUT_MS = 30_000;
const TELEGRAM_TIMEOUT_MS = 15_000;
const STATE_DIR = process.env.TELEGRAM_ALERT_STATE_DIR || "/tmp/telegram-alert";
const STATE_FILE = join(STATE_DIR, "state.json");
const AUDIT_LOG = join(STATE_DIR, "audit.log");

interface AlertState {
  alertedItems: Record<string, number>;
}

interface AlertItem {
  id: string;
  category: "blocked" | "approval_needed" | "question_for_jeff" | "critical_production";
  identifier: string;
  title: string;
  agent?: string;
  reason: string;
  link: string;
  explanation?: string;
  actionText?: string;
}

interface Interaction {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  targetUserId?: string;
  payload?: {
    title?: string;
    summary?: string;
    recommendedAction?: string;
  };
}

function missingEnv(name: string): void {
  console.error(`Missing required env: ${name}`);
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function readState(): AlertState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // corrupted state file, start fresh
  }
  return { alertedItems: {} };
}

function writeState(state: AlertState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function auditLog(message: string): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const safe = message.replace(/\n/g, "\\n");
  appendFileSync(AUDIT_LOG, `${ts} ${safe}\n`);
}

function tokenSafe(str: string): string {
  if (!BOT_TOKEN) return str;
  return str.replaceAll(BOT_TOKEN, "[REDACTED]");
}

function shouldAlert(state: AlertState, itemId: string): boolean {
  const lastAlerted = state.alertedItems[itemId];
  if (!lastAlerted) return true;
  return Date.now() - lastAlerted > COOLDOWN_MS;
}

function markAlerted(state: AlertState, itemId: string): void {
  state.alertedItems[itemId] = Date.now();
}

async function apiGet<T>(path: string): Promise<T> {
  const url = `${PAPERCLIP_API_URL}${path}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status} for ${path}`);
  }
  return res.json() as Promise<T>;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function sendTelegram(item: AlertItem): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    auditLog(`SKIP no BOT_TOKEN/CHAT_ID configured`);
    return false;
  }

  const headlineMap: Record<string, string> = {
    blocked: "\u{1F534} BLOCKED TASK",
    approval_needed: "\u2705 APPROVAL NEEDED",
    question_for_jeff: "\u2753 QUESTION FOR YOU",
    critical_production: "\u26A0\uFE0F CRITICAL ISSUE",
  };

  const text = [
    `*${headlineMap[item.category]}*`,
    ``,
    `${item.identifier} \u2014 ${escapeMarkdown(item.title)}`,
    item.explanation ? escapeMarkdown(item.explanation) : "",
    ``,
    `*What you can do:*`,
    item.actionText ? escapeMarkdown(item.actionText) : "",
    ``,
    item.link,
  ]
    .filter(Boolean)
    .join("\n");

  const body = {
    chat_id: CHAT_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const ok = res.ok;
    const responseText = ok ? "sent" : `HTTP ${res.status}`;
    auditLog(`${item.category} ${item.identifier} ${responseText}`);
    if (!ok) {
      const errBody = await res.text().catch(() => "unknown");
      console.error(
        `Telegram API error for ${item.identifier}: ${res.status} ${tokenSafe(errBody)}`
      );
    }
    return ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(`${item.category} ${item.identifier} FAIL ${tokenSafe(msg)}`);
    console.error(`Telegram send failed for ${item.identifier}: ${tokenSafe(msg)}`);
    return false;
  }
}

function makeLink(identifier: string): string {
  const prefix = identifier.split("-")[0];
  return `https://paperclip.avva.aero/${prefix}/issues/${identifier}`;
}

function makeApprovalLink(approvalId: string): string {
  return `https://paperclip.avva.aero/CRE/approvals/${approvalId}`;
}

interface ApiIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockedBy?: Array<{ id: string }>;
  blockedByIssueIds?: string[];
}

async function getBlockedIssues(): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  try {
    const issues = await apiGet<ApiIssue[]>(
      `/api/companies/${COMPANY_ID}/issues?status=blocked&includeBlockedBy=true`
    );
    for (const issue of issues) {
      if (issue.status !== "blocked") continue;
      const blockerCount = (issue.blockedBy || issue.blockedByIssueIds || []).length;
      items.push({
        id: issue.id,
        category: "blocked",
        identifier: issue.identifier,
        title: issue.title,
        reason: `Task is blocked (${blockerCount} blocker(s))`,
        link: makeLink(issue.identifier),
        explanation: `${issue.identifier} is blocked by ${blockerCount} unresolved issue(s).`,
        actionText: `Open ${issue.identifier} to review blockers and unblock by changing status from 'Blocked' to 'To Do'.`,
      });
    }
  } catch (err) {
    console.error("Failed fetching blocked issues:", err);
  }
  return items;
}

async function getQuestionsForJeff(): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  try {
    const issues = await apiGet<ApiIssue[]>(
      `/api/companies/${COMPANY_ID}/issues?status=blocked,in_progress,in_review,todo&limit=50`
    );
    for (const issue of issues) {
      const interactions = await apiGet<Interaction[]>(
        `/api/issues/${issue.id}/interactions`
      );
      for (const interaction of interactions) {
        if (interaction.status === "pending" && interaction.targetUserId === "jdogVxlZPWoYam0aNGo3meqX7ZRkMXMS") {
          items.push({
            id: `${issue.id}-q-${interaction.id}`,
            category: "question_for_jeff",
            identifier: issue.identifier,
            title: issue.title,
            reason: "Agent has a question for you",
            link: makeLink(issue.identifier),
            explanation: interaction.payload?.summary || `An agent is waiting for your response on ${issue.identifier}.`,
            actionText: `Open ${issue.identifier} to review and respond to the question.`,
          });
          break;
        }
      }
    }
  } catch (err) {
    console.error("Failed fetching questions for Jeff:", err);
  }
  return items;
}

async function getCriticalProductionIssues(): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  try {
    const issues = await apiGet<ApiIssue[]>(
      `/api/companies/${COMPANY_ID}/issues?priority=critical&status=blocked,in_progress,in_review,todo&limit=50`
    );
    for (const issue of issues) {
      if (issue.priority !== "critical") continue;
      items.push({
        id: issue.id,
        category: "critical_production",
        identifier: issue.identifier,
        title: issue.title,
        reason: "Critical production issue requires executive awareness",
        link: makeLink(issue.identifier),
        explanation: `Issue ${issue.identifier} is a critical priority production concern.`,
        actionText: `Review ${issue.identifier} to assess impact and assign resources.`,
      });
    }
  } catch (err) {
    console.error("Failed fetching critical production issues:", err);
  }
  return items;
}

interface Approval {
  id: string;
  type: string;
  title: string;
  summary?: string;
  status: string;
  issueIds?: string[];
  requestedByAgentId?: string;
  payload?: { title?: string; summary?: string; recommendedAction?: string };
}
async function getPendingApprovals(): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  try {
    const approvals = await apiGet<Approval[]>(
      `/api/companies/${COMPANY_ID}/approvals?status=pending`
    );
    for (const approval of approvals) {
      const title = approval.payload?.title || approval.title || "Untitled";
      const summary = approval.payload?.summary || approval.summary || "";
      const rec = approval.payload?.recommendedAction
        ? ` — ${approval.payload.recommendedAction}`
        : "";
      items.push({
        id: approval.id,
        category: "approval_needed",
        identifier: approval.id.slice(0, 8),
        title,
        reason: summary + rec || "Board approval requested",
        link: makeApprovalLink(approval.id),
        explanation: summary || `Your approval is requested: ${title}.`,
        actionText: `Open the approval to review and ${approval.type === "request_board_approval" ? "approve or deny" : "respond"}.`,
      });
    }
  } catch (err) {
    console.error("Failed fetching pending approvals:", err);
  }
  return items;
}

async function sendAll(items: AlertItem[]): Promise<void> {
  for (const item of items) {
    await sendTelegram(item);
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  const alertsEnabled = process.env.TELEGRAM_ALERTS_ENABLED;
  if (alertsEnabled === "false" || alertsEnabled === "0") {
    console.log("TELEGRAM_ALERTS_ENABLED is false/0, exiting silently.");
    process.exit(0);
  }

  if (!BOT_TOKEN) missingEnv("TELEGRAM_BOT_TOKEN (or BOT_TOKEN)");
  if (!CHAT_ID) missingEnv("JEFF_TELEGRAM_CHAT_ID (or CHAT_ID)");
  if (!PAPERCLIP_API_URL) missingEnv("PAPERCLIP_API_URL");
  if (!PAPERCLIP_API_KEY) missingEnv("PAPERCLIP_API_KEY");
  if (!COMPANY_ID) missingEnv("COMPANY_ID");

  if (!PAPERCLIP_API_URL || !PAPERCLIP_API_KEY || !COMPANY_ID) {
    fail("Missing required Paperclip env vars (PAPERCLIP_API_URL, PAPERCLIP_API_KEY, COMPANY_ID)");
  }

  const state = readState();
  const allItems = [
    ...(await getBlockedIssues()),
    ...(await getPendingApprovals()),
    ...(await getQuestionsForJeff()),
    ...(await getCriticalProductionIssues()),
  ];

  const toSend: AlertItem[] = [];
  for (const item of allItems) {
    if (shouldAlert(state, item.id)) {
      toSend.push(item);
    }
  }

  if (toSend.length === 0) {
    auditLog("CHECK no new items to alert");
    console.log("No new items to alert.");
    process.exit(0);
  }

  console.log(`Sending ${toSend.length} alert(s)...`);
  await sendAll(toSend);

  for (const item of toSend) {
    markAlerted(state, item.id);
  }
  writeState(state);

  auditLog(`DONE sent ${toSend.length} alert(s)`);
  console.log(`Done. ${toSend.length} alert(s) sent.`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${tokenSafe(msg)}`);
  auditLog(`FATAL ${tokenSafe(msg)}`);
  process.exit(1);
});
