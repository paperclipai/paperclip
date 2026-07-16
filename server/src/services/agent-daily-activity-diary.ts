// Agent daily-activity diaries (FIG-527) are intentionally idle between Discord
// ingresses and are closed at 00:00 Europe/Rome by close_stale_discord_diaries.py
// (FIG-543). Recovery and productivity-review watchdogs must not treat them as
// stranded or as productivity outliers — they will trip both detectors on any
// busy ingestion day, generating recovery siblings and productivity-review
// issues that are pure noise.
//
// Title contract from vault-endpoint/app/wake_service.py::daily_activity_title:
// "<agentName>-<d|dd><Mon><yyyy> - Discord activity" (Europe/Rome).
export const AGENT_DAILY_ACTIVITY_DIARY_TITLE_REGEX =
  /^.+-\d{1,2}[A-Z][a-z]{2}\d{4} - Discord activity$/;

export function isAgentDailyActivityDiary(issue: { title: string | null }): boolean {
  const title = typeof issue.title === "string" ? issue.title.trim() : "";
  if (!title) return false;
  return AGENT_DAILY_ACTIVITY_DIARY_TITLE_REGEX.test(title);
}
