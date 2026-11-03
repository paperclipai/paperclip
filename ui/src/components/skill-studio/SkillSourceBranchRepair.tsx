import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SkillSource } from '@paperclipai/shared';
import { skillSourcesApi } from '@/api/skillSources';
import { ApiError } from '@/api/client';
import { queryKeys } from '@/lib/queryKeys';
import { SkillSourceBranchRepairDialog } from './SkillSourceBranchRepairDialog';

export function SkillSourceBranchRepair({ companyId, source, connectionId, onSaved, onClose, onReturnFocus }: {
  companyId: string; source: SkillSource; connectionId?: string; onSaved: () => Promise<void>;
  onClose: () => void; onReturnFocus?: () => void;
}) {
  const client = useQueryClient();
  const branches = useQuery({
    queryKey: ['skill-source-branches', companyId, source.id, connectionId ?? source.connectionId],
    queryFn: ({ signal }) => skillSourcesApi.branches(companyId, source.id, connectionId ? { connectionId } : {}, signal),
    retry: false, refetchOnMount: 'always',
  });
  async function save(branch: string) {
    try {
      await skillSourcesApi.settings(companyId, source.id, { revision: source.revision, trackingRef: branch, ...(connectionId ? { connectionId } : {}) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && (error.body as { code?: string } | null)?.code === 'skill_source_settings_changed') {
        await client.invalidateQueries({ queryKey: queryKeys.skillSources.all(companyId) });
        throw new Error('This source is refreshing or changed. Your branch is still selected. Try saving again.');
      }
      if (error instanceof ApiError && (error.body as { code?: string } | null)?.code === 'skill_source_ref_unavailable') {
        throw new Error('GitHub could not find that branch or revision. Check the name or choose another branch.');
      }
      throw error;
    }
    await onSaved();
  }
  return <SkillSourceBranchRepairDialog repository={source.fullName} currentBranch={source.trackingRef}
    branches={branches.data?.branches ?? []} loading={branches.isFetching} loadError={branches.error?.message}
    onRetry={() => void branches.refetch()} onSave={save} onClose={onClose} onReturnFocus={onReturnFocus} />;
}
