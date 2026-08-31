/**
 * Per-task composer draft persistence, shared by the chat composers.
 *
 * Draft text is kept in localStorage under the caller-provided key. All
 * access is guarded so disabled or full storage never throws into React.
 * Empty drafts remove the key, and only text is persisted.
 */

/** Debounce before a keystroke lands in localStorage. */
export const DRAFT_DEBOUNCE_MS = 800;

export function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

export function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadStructuredDraft<T>(draftKey: string, fallback: T): T {
  try {
    const value = localStorage.getItem(draftKey);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export function saveStructuredDraft(draftKey: string, value: unknown) {
  try {
    localStorage.setItem(draftKey, JSON.stringify(value));
  } catch {
    // Ignore localStorage failures.
  }
}
