import { t, useTranslation } from "@/i18n";
import type { CompanySkill } from '@paperclipai/shared';
import { Link } from '@/lib/router';
export function SkillSourceProvenance({ skill }: { skill: CompanySkill }) {
  useTranslation("task-components");
  const id = skill.metadata?.skillSourceId ?? skill.metadata?.legacySkillSourceId;
  if (typeof id !== 'string') return null;
  const state = skill.metadata?.skillSourceState;
  const label = !skill.metadata?.skillSourceId ? t("final-components-a:refreshThisSourceToSync_362ee926") : state === 'removed' ? t("final-components-a:removedFromSourceLastInstalled_5244d4a5")
    : state === 'not_syncing' ? t("final-components-a:notSyncingInstalledCopyRetained_97ad0aa0")
    : state === 'update_failed' ? t("final-components-a:updateFailedLastInstalledVersion_a83a5fd3") : t("final-components-a:syncedFromGitHub_4e73c187");
  return <div className="flex flex-col gap-1 py-3 text-xs text-muted-foreground">
    <span>{label}</span>
    <span className="break-all font-mono">{String(skill.metadata?.skillSourcePath ?? '')}{skill.sourceRef ? ` · ${skill.sourceRef.slice(0, 8)}` : ''}</span>
    <Link to={`/skills/sources/${id}`} className="text-foreground underline">{t("task-components:manageSource_d68ebd7c")}</Link>
  </div>;
}
