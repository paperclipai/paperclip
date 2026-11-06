import type { CompanySkill } from '@paperclipai/shared';
import { Link } from '@/lib/router';
import { useTranslation } from '@/i18n';
export function SkillSourceProvenance({ skill }: { skill: CompanySkill }) {
  const { t } = useTranslation();
  const id = skill.metadata?.skillSourceId ?? skill.metadata?.legacySkillSourceId;
  if (typeof id !== 'string') return null;
  const state = skill.metadata?.skillSourceState;
  const label = !skill.metadata?.skillSourceId ? t('skills.SkillSourceProvenance.refreshToSync') : state === 'removed' ? t('skills.SkillSourceProvenance.removedFromSource')
    : state === 'not_syncing' ? t('skills.SkillSourceProvenance.notSyncing')
    : state === 'update_failed' ? t('skills.SkillSourceProvenance.updateFailed') : t('skills.SkillSourceProvenance.syncedFromGithub');
  return <div className="flex flex-col gap-1 py-3 text-xs text-muted-foreground">
    <span>{label}</span>
    <span className="break-all font-mono">{String(skill.metadata?.skillSourcePath ?? '')}{skill.sourceRef ? ` · ${skill.sourceRef.slice(0, 8)}` : ''}</span>
    <Link to={`/skills/sources/${id}`} className="text-foreground underline">{t('skills.SkillSourceProvenance.manageSource')}</Link>
  </div>;
}
