import type { AgentSetupProgressHandoff } from "@paperclipai/shared";

/**
 * The agent setup handoff (checklist id, token and URLs) for one setup, kept in
 * this tab so a reload follows the checklist the copied prompt writes to. The
 * token can do nothing but update that checklist until it expires, and sign-out
 * clears every stored handoff so the next account in the tab never inherits one.
 */
const PREFIX = "paperclip:agent-setup-progress:";

export function agentSetupHandoffStorageKey(companyId: string | null | undefined, purpose: string, subjectId: string | null | undefined) {
  return `${PREFIX}${companyId ?? ""}:${purpose}:${subjectId ?? ""}`;
}

export function storedAgentSetupHandoff(key: string): AgentSetupProgressHandoff | null {
  try {
    const value = window.sessionStorage.getItem(key);
    const parsed = value ? JSON.parse(value) as AgentSetupProgressHandoff : null;
    return parsed && Date.parse(parsed.progress.expiresAt) > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

export function storeAgentSetupHandoff(key: string, handoff: AgentSetupProgressHandoff | null) {
  try {
    if (handoff) window.sessionStorage.setItem(key, JSON.stringify(handoff));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private windows); the checklist then lasts until the page reloads.
  }
}

/** Removes every stored handoff in this tab. Sign-out calls it. */
export function clearAgentSetupHandoffs() {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // Nothing stored when storage is unavailable.
  }
}
