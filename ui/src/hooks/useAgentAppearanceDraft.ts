import { useState } from "react";
import { agentAppearanceSchema, randomAgentAppearance } from "@paperclipai/shared";

/** Non-secret visual identity only. The caller remounts when its draft key changes. */
export function useAgentAppearanceDraft(draftKey: string) {
  const key = `paperclip.agent-appearance.${draftKey}`;
  const [appearance] = useState(() => {
    try {
      const stored = agentAppearanceSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? "null"));
      if (stored.success) return stored.data;
    } catch { /* Storage can be unavailable; retain the in-memory assignment. */ }
    const value = randomAgentAppearance();
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory draft still works. */ }
    return value;
  });
  return { appearance, clear() { try { sessionStorage.removeItem(key); } catch { /* Best effort. */ } } };
}
