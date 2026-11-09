import { describeError } from "@/api/errors";
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SkillSource } from '@paperclipai/shared';
import { skillSourcesApi } from '@/api/skillSources';
import { ApiError } from '@/api/client';
import { queryKeys } from '@/lib/queryKeys';
import { Link } from '@/lib/router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioCardGroup } from '@/components/ui/radio-card';
import { useTranslation } from '@/i18n';
import { SkillSourceBranchRepair } from './SkillSourceBranchRepair';

export function SkillSourceConnectionRepair({ companyId, source, onClose, onSaved, onReturnFocus }: {
  companyId: string; source: SkillSource; onClose: () => void; onSaved: () => Promise<void>;
  onReturnFocus?: () => void;
}) {
  const { t } = useTranslation();
  const [connectionId, setConnectionId] = useState(source.connectionId ?? '');
  const [chooseBranch, setChooseBranch] = useState(false);
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.skillSources.repositories(companyId), queryFn: () => skillSourcesApi.repositories(companyId), refetchOnMount: 'always' });
  const save = useMutation({ mutationFn: () => skillSourcesApi.settings(companyId, source.id, { revision: source.revision, connectionId }),
    onError: async error => {
      if (error instanceof ApiError && error.status === 409 && (error.body as { code?: string } | null)?.code === 'skill_source_settings_changed') {
        await client.invalidateQueries({ queryKey: queryKeys.skillSources.all(companyId) });
      }
    },
    onSuccess: async () => { await onSaved(); onClose(); } });
  const connections = query.data?.connections ?? [];
  const branchMissing = save.error instanceof ApiError && (save.error.body as { code?: string } | null)?.code === 'skill_source_ref_unavailable';
  const canSave = connections.some(connection => connection.id === connectionId);
  if (chooseBranch) return <SkillSourceBranchRepair companyId={companyId} source={source} connectionId={connectionId}
    onClose={() => setChooseBranch(false)} onReturnFocus={onReturnFocus} onSaved={async () => { await onSaved(); onClose(); }} />;
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}>
    <DialogContent className="flex max-h-(--sz-calc-18) flex-col overflow-hidden sm:max-w-md"
      onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus(); } }}>
      <DialogHeader className="shrink-0">
        <DialogTitle>{t('skills.SkillSourceConnectionRepair.title')}</DialogTitle>
        <DialogDescription>{t('skills.SkillSourceConnectionRepair.description')}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto space-y-4">
      {query.isPending && <p role="status" className="text-sm text-muted-foreground">{t('skills.SkillSourceConnectionRepair.loadingConnections')}</p>}
      {query.error && <p role="alert" className="text-sm text-destructive">{describeError(query.error).body} <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>{t('skills.SkillSourceConnectionRepair.tryAgain')}</Button></p>}
      <RadioCardGroup ariaLabel={t('skills.SkillSourceConnectionRepair.ariaLabel')} value={connectionId} onValueChange={setConnectionId} disabled={save.isPending}
        options={connections.map(connection => ({ value: connection.id, title: connection.name }))} />
      {query.isSuccess && connections.length === 0 && <p className="text-sm text-muted-foreground">{t('skills.SkillSourceConnectionRepair.connectFirst')}</p>}
      <Button asChild variant="link" className="justify-start p-0"><Link to="/apps">{t('skills.SkillSourceConnectionRepair.manageConnections')}</Link></Button>
      {save.error && <p role="alert" className="text-sm text-destructive">{save.error instanceof ApiError && save.error.status === 409 && (save.error.body as { code?: string } | null)?.code === 'skill_source_settings_changed'
        ? t('skills.SkillSourceConnectionRepair.sourceUpdated') : save.error.message}</p>}
      {branchMissing && source.accessScope !== 'projects' && !source.projects?.some(project => project.active) && <Button variant="outline" disabled={!canSave || save.isPending} onClick={() => setChooseBranch(true)}>{t('skills.SkillSourceConnectionRepair.chooseBranch')}</Button>}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" disabled={save.isPending} onClick={onClose}>{t('skills.SkillSourceConnectionRepair.cancel')}</Button>
        <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('skills.SkillSourceConnectionRepair.saving') : t('skills.SkillSourceConnectionRepair.saveConnection')}</Button>
      </footer>
    </DialogContent>
  </Dialog>;
}
