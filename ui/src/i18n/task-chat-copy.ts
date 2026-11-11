import type { IssueWorkMode } from "@paperclipai/shared";

import { isRussianLocale } from "./tx";

/** Composer placeholder. The agent name stays as given and is not inflected. */
export function composerPlaceholder(
  language: string | undefined,
  mode: IssueWorkMode,
  agentName: string,
  mobile: boolean,
): string {
  const ru = isRussianLocale(language);
  if (mobile) {
    if (mode === "planning") return ru ? `План с ${agentName}…` : `Plan with ${agentName}…`;
    if (mode === "ask") return ru ? `Спросить ${agentName}…` : `Ask ${agentName}…`;
    return ru ? `Сообщение для ${agentName}…` : `Message ${agentName}…`;
  }
  switch (mode) {
    case "planning":
      return ru
        ? `План с ${agentName} — только документ плана, без правок кода…`
        : `Plan with ${agentName} — shapes the plan doc, no code changes…`;
    case "ask":
      return ru
        ? `Вопрос для ${agentName} — только чтение, ничего не запускается…`
        : `Ask ${agentName} a question — read-only, nothing runs…`;
    default:
      return ru
        ? `Сообщение для ${agentName} — опишите, что нужно сделать…`
        : `Message ${agentName} — describe what you want done…`;
  }
}

/** Settled turn header: "Stopped" / "Worked", with a duration when the row has one. */
export function turnOutcomeLabel(
  language: string | undefined,
  failed: boolean,
  durationLabel?: string | null,
): string {
  if (!isRussianLocale(language)) {
    const verb = failed ? "Stopped" : "Worked";
    return durationLabel ? `${verb} for ${durationLabel}` : verb;
  }
  const verb = failed ? "Остановлено" : "Готово";
  return durationLabel ? `${verb} за ${durationLabel}` : verb;
}
