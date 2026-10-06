import { t, useTranslation } from "@/i18n";
import type { CompanySkill } from '@paperclipai/shared';
import { Link } from '@/lib/router';
export function SkillSourceProvenance({ skill }: { skill: CompanySkill }) {
  useTranslation();
  const id = skill.metadata?.skillSourceId ?? skill.metadata?.legacySkillSourceId;
  if (typeof id !== 'string') return null;
  const state = skill.metadata?.skillSourceState;
  const label = !skill.metadata?.skillSourceId ? t("oct5Core.s0097") : state === 'removed' ? t("oct5Core.s0098")
    : state === 'not_syncing' ? t("oct5Core.s0099")
    : state === 'update_failed' ? t("oct5Core.s0100") : t("oct5Core.s0101");
  return <div className="flex flex-col gap-1 py-3 text-xs text-muted-foreground">
    <span>{label}</span>
    <span className="break-all font-mono">{String(skill.metadata?.skillSourcePath ?? '')}{skill.sourceRef ? ` · ${skill.sourceRef.slice(0, 8)}` : ''}</span>
    <Link to={`/skills/sources/${id}`} className="text-foreground underline">{t("oct5Core.s0102")}</Link>
  </div>;
}
