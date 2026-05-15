import { paperclipGet, paperclipPost, paperclipPut, paperclipDelete, COMPANY_ID } from "./api.ts";
import type { PaperclipIssue } from "../types.ts";

export interface PendingTask {
  title: string;
  description: string;
  assigneeName?: string;
  sourceMessage: string;
  createdAt: number;
  awaitingAssign?: boolean;
  originalDraftTitle?: string;
  sourceIssueId?: string;
  sourceIssueIdentifier?: string;
  destructiveAction?: string;
}

// ── In-memory cache (fast path for same-isolate requests) ──
const cache = new Map<number, PendingTask>();

// ── State issue ID (lazy-initialized, cached per isolate) ──
let stateIssueId: string | null = null;

const STATE_ISSUE_TITLE = "Chase Telegram State";

async function getOrCreateStateIssue(): Promise<string> {
  if (stateIssueId) return stateIssueId;

  // Search for existing state issue
  const issues = await paperclipGet<PaperclipIssue[]>(
    `/api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(STATE_ISSUE_TITLE)}&limit=5`,
  );
  const existing = issues.find((i) => i.title === STATE_ISSUE_TITLE);
  if (existing) {
    stateIssueId = existing.id;
    return stateIssueId;
  }

  // Create a new state issue
  const issue = await paperclipPost<PaperclipIssue>(
    `/api/companies/${COMPANY_ID}/issues`,
    {
      title: STATE_ISSUE_TITLE,
      description: "Internal state storage for Chase Telegram bot. Do not modify manually.",
      status: "done",
      priority: "low",
    },
  );
  stateIssueId = issue.id;
  return stateIssueId;
}

function docKey(chatId: number): string {
  return `pending-telegram-${chatId}`;
}

// ── Load pending task from persistent storage into the in-memory cache ──
export async function refreshFromStorage(chatId: number): Promise<void> {
  try {
    const issueId = await getOrCreateStateIssue();
    const doc = await paperclipGet<{ body: string }>(
      `/api/issues/${issueId}/documents/${docKey(chatId)}`,
    );
    const task = JSON.parse(doc.body) as PendingTask;
    if (task && task.sourceMessage) {
      cache.set(chatId, task);
    }
  } catch {
    // No document found or parse error — not a problem
  }
}

// ── Synchronous cache lookup (called from routeQuery which is sync) ──
export function getPendingTask(chatId: number): PendingTask | undefined {
  return cache.get(chatId);
}

// ── Store pending task (cache + persistent) ──
export async function setPendingTask(chatId: number, task: PendingTask): Promise<void> {
  cache.set(chatId, task);
  try {
    const issueId = await getOrCreateStateIssue();
    await paperclipPut(
      `/api/issues/${issueId}/documents/${docKey(chatId)}`,
      {
        format: "markdown",
        body: JSON.stringify(task),
        title: `${chatId}`,
      },
    );
  } catch (err) {
    console.error(`Failed to persist pending task [chatId=${chatId}]: ${err}`);
  }
}

// ── Clear pending task (cache + persistent) ──
export async function clearPendingTask(chatId: number): Promise<void> {
  cache.delete(chatId);
  try {
    const issueId = await getOrCreateStateIssue();
    await paperclipDelete(`/api/issues/${issueId}/documents/${docKey(chatId)}`);
  } catch {
    // Document may not exist — not a problem
  }
}
