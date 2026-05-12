/**
 * Load chat-id → company mapping from vault workspace files.
 *
 * Each `00-system/workspaces/<name>.md` declares:
 *   - name: workspace identifier
 *   - telegram_chats: array of chat IDs
 *   - paperclip_company_id: UUID of the Paperclip company (added in P1A-4)
 *   - paperclip_default_agent_id: UUID of Karl in this company (added in P1A-4)
 *
 * Built at bridge startup; refreshable on workspace-file change watcher.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import matter from "gray-matter";
import type { ChatToCompanyMapping, WorkspaceName } from "./types.js";

const WORKSPACE_DIR = `${process.env.HOME}/second-brain/00-system/workspaces`;

const VALID_WORKSPACES: WorkspaceName[] = ["personal", "work", "finance", "noted"];

/** Vault file frontmatter shape (subset we use). */
type WorkspaceFrontmatter = {
  name?: string;
  telegram_chats?: string[];
  paperclip_company_id?: string;
  paperclip_default_agent_id?: string;
  paperclip_require_mention?: boolean;
};

/**
 * Map vault workspace name → canonical bridge name. Vault calls the
 * personal workspace "karl" historically; bridge uses "personal" per
 * AGENT-INFRA §4.3 four-company model.
 */
function normalizeWorkspaceName(raw: string | undefined): WorkspaceName | null {
  if (!raw) return null;
  if (raw === "karl") return "personal"; // vault legacy alias
  if (VALID_WORKSPACES.includes(raw as WorkspaceName)) return raw as WorkspaceName;
  return null;
}

export async function loadChatMappings(
  dir: string = WORKSPACE_DIR,
): Promise<ChatToCompanyMapping[]> {
  const entries = await readdir(dir);
  const out: ChatToCompanyMapping[] = [];
  const issues: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const raw = await readFile(path, "utf-8");
    const parsed = matter(raw);
    const fm = parsed.data as WorkspaceFrontmatter;

    const workspace = normalizeWorkspaceName(fm.name);
    if (!workspace) {
      issues.push(`${entry}: name="${fm.name}" not a recognized workspace`);
      continue;
    }
    if (!fm.paperclip_company_id) {
      // Phase 1A-4 hasn't run yet for this workspace. Skip but flag.
      issues.push(`${entry}: paperclip_company_id missing — register company in Phase 1A-4`);
      continue;
    }
    const chats = Array.isArray(fm.telegram_chats) ? fm.telegram_chats : [];
    if (chats.length === 0) {
      issues.push(`${entry}: no telegram_chats declared`);
      continue;
    }
    for (const chatId of chats) {
      out.push({
        chatId: String(chatId),
        companyId: fm.paperclip_company_id,
        workspace,
        defaultAgent: fm.paperclip_default_agent_id ? "__id__" : "karl",
        defaultAgentId: fm.paperclip_default_agent_id,
        requireMention: Boolean(fm.paperclip_require_mention),
      });
    }
  }

  if (issues.length > 0 && process.env.MATTCLAW_VERBOSE) {
    console.warn("[chat-mappings] partial load:", issues.join("; "));
  }
  return out;
}

/**
 * Look up a chat ID in the mapping table.
 */
export function findMappingForChat(
  mappings: ChatToCompanyMapping[],
  chatId: string,
  threadId?: number,
): ChatToCompanyMapping | null {
  // Exact match on chatId + threadId first, then chatId alone
  if (threadId != null) {
    const exact = mappings.find((m) => m.chatId === chatId && m.threadId === threadId);
    if (exact) return exact;
  }
  return mappings.find((m) => m.chatId === chatId) ?? null;
}
