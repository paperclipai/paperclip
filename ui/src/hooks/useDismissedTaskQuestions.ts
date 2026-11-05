import { useCallback, useMemo, useState } from "react";

function loadDismissedQuestions(storageKey: string | null): Set<string> {
  try {
    const value: unknown = JSON.parse(storageKey ? localStorage.getItem(storageKey) ?? "[]" : "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Browser fallback for all composer requests; saved interaction dismissal also lives on the server.
 * Keep the original storage key so existing question dismissals survive upgrades. */
export function useDismissedTaskQuestions(issueId?: string | null, userId?: string | null) {
  const storageKey = issueId ? `paperclip:task-question-dismissals:${userId ?? "board"}:${issueId}` : null;
  const [state, setState] = useState(() => ({ storageKey, ids: loadDismissedQuestions(storageKey) }));
  const dismissedQuestionIds = useMemo(() => state.storageKey === storageKey
    ? state.ids : loadDismissedQuestions(storageKey), [state, storageKey]);
  const dismissQuestion = useCallback((interactionId: string) => {
    // Another tab may have saved more dismissals since this thread rendered.
    const ids = new Set([...loadDismissedQuestions(storageKey), ...dismissedQuestionIds]);
    ids.add(interactionId);
    try {
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify([...ids]));
    } catch {
      // Keep dismissal effective for this mounted thread when storage is unavailable.
    }
    setState({ storageKey, ids });
  }, [dismissedQuestionIds, storageKey]);
  return { dismissedQuestionIds, dismissQuestion };
}
