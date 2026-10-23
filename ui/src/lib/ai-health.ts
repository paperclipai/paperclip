import type { CompanyAiConnectionHealth, CompanyAiHealth } from "@paperclipai/shared";

export const AI_HEALTH_DISMISS_MS = 24 * 60 * 60 * 1000;
const DISMISSAL_CHANGE_EVENT = "paperclip:ai-health-dismissal";

export function aiConnectionHref(connectionId: string): string {
  return `/apps/${connectionId}/permissions`;
}

export function connectionProblem(status: CompanyAiConnectionHealth["status"]): string {
  if (status === "revoked") return "was revoked";
  if (status === "expired") return "has expired";
  return "needs sign-in";
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export interface AiHealthProblems {
  brokenConnections: CompanyAiConnectionHealth[];
  affectedAgentCount: number;
  signature: string;
}

export function summarizeAiHealth(health: CompanyAiHealth | undefined): AiHealthProblems {
  const brokenConnections = health?.connections ?? [];
  const affectedAgentCount = new Set(brokenConnections.flatMap((connection) => connection.affectedAgentIds)).size;
  const signature = brokenConnections.length
    ? JSON.stringify(brokenConnections.map((connection) => `${connection.id}:${connection.status}`).sort())
    : "";
  return { brokenConnections, affectedAgentCount, signature };
}

function dismissalKey(companyId: string): string {
  return `paperclip:ai-health-dismissal:${companyId}`;
}

/** Returns when the dismissal of this broken set ends, or null when it is not dismissed. */
export function readAiHealthDismissal(companyId: string, signature: string, now = Date.now()): number | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(dismissalKey(companyId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return null;
    const { signature: storedSignature, dismissedAt } = stored as { signature?: unknown; dismissedAt?: unknown };
    if (storedSignature !== signature || typeof dismissedAt !== "number") return null;
    const hiddenUntil = dismissedAt + AI_HEALTH_DISMISS_MS;
    return hiddenUntil > now ? hiddenUntil : null;
  } catch {
    return null;
  }
}

/** Forgets a dismissal of a broken set that is no longer the current one, so a later break shows again. */
export function clearStaleAiHealthDismissal(companyId: string, signature: string): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(dismissalKey(companyId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return;
    if ((stored as { signature?: unknown }).signature === signature) return;
  } catch {
    return;
  }
  writeAiHealthDismissal(companyId, null);
}

export function writeAiHealthDismissal(companyId: string, signature: string | null, now = Date.now()): void {
  try {
    if (signature) localStorage.setItem(dismissalKey(companyId), JSON.stringify({ signature, dismissedAt: now }));
    else localStorage.removeItem(dismissalKey(companyId));
  } catch {
    // Without storage the bar stays visible.
  }
  window.dispatchEvent(new Event(DISMISSAL_CHANGE_EVENT));
}

export function subscribeAiHealthDismissal(onChange: () => void): () => void {
  window.addEventListener(DISMISSAL_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DISMISSAL_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
