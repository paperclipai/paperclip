import type { CompanySkill } from '@paperclipai/shared';
import { Link } from '@/lib/router';
export function SkillSourceProvenance({ skill }: { skill: CompanySkill }) {
  const id = skill.metadata?.skillSourceId ?? skill.metadata?.legacySkillSourceId;
  if (typeof id !== 'string') return null;
  const state = skill.metadata?.skillSourceState;
  const label = !skill.metadata?.skillSourceId ? 'Refresh this source to sync all files' : state === 'removed' ? 'Removed from source · last installed version retained'
    : state === 'not_syncing' ? 'Not syncing · installed copy retained'
    : state === 'update_failed' ? 'Update failed · last installed version retained' : 'Synced from GitHub';
  return <div className="flex flex-col gap-1 py-3 text-xs text-muted-foreground">
    <span>{label}</span>
    <span className="break-all font-mono">{String(skill.metadata?.skillSourcePath ?? '')}{skill.sourceRef ? ` · ${skill.sourceRef.slice(0, 8)}` : ''}</span>
    <Link to={`/skills/sources/${id}`} className="text-foreground underline">Manage source</Link>
  </div>;
}
