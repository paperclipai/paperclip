const STORAGE_KEY = "paperclip:composer-effort";

/** Undefined means no preference; null is the user's explicit Default choice. */
export function getLastComposerEffort(companyId: string): string | null | undefined {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${companyId}`);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return value === null || typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rememberComposerEffort(companyId: string, effort: string | null): void {
  try {
    localStorage.setItem(`${STORAGE_KEY}:${companyId}`, JSON.stringify(effort));
  } catch {
    // The current run setting still works without persistent storage.
  }
}
