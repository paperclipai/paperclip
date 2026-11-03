import { t } from "@/i18n";

const levelKeys: Record<string, string> = {
  company: "localizationGoals.level_company",
  team: "localizationGoals.level_team",
  agent: "localizationGoals.level_agent",
  task: "localizationGoals.level_task",
};

/** Display only: callers keep the original level when editing or submitting. */
export function goalLevelLabel(level: string): string {
  return levelKeys[level] ? t(levelKeys[level]) : level;
}
