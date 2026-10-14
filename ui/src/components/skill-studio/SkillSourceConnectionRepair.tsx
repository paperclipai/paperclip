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

export function SkillSourceConnectionRepair({ companyId, source, onClose, onSaved, onReturnFocus }: {
  companyId: string; source: SkillSource; onClose: () => void; onSaved: () => Promise<void>;
  onReturnFocus?: () => void;
}) {
  const [connectionId, setConnectionId] = useState('');
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.skillSources.repositories(companyId), queryFn: () => skillSourcesApi.repositories(companyId), refetchOnMount: 'always', retry: false });
  const save = useMutation({ mutationFn: () => skillSourcesApi.settings(companyId, source.id, { revision: source.revision, connectionId }),
    onError: async error => {
      if (error instanceof ApiError && error.status === 409) {
        await client.invalidateQueries({ queryKey: queryKeys.skillSources.all(companyId) });
      }
    },
    onSuccess: async () => { await onSaved(); onClose(); } });
  const connections = query.data?.connections ?? [];
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}>
    <DialogContent className="flex max-h-(--sz-calc-18) flex-col overflow-hidden sm:max-w-md"
      onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus(); } }}>
      <DialogHeader className="shrink-0">
        <DialogTitle>Choose GitHub connection</DialogTitle>
        <DialogDescription>Automatic updates will use your access to this connection. Installed skills and selections stay in place.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto space-y-4">
      {query.isPending && <p role="status" className="text-sm text-muted-foreground">Loading connections…</p>}
      {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message} <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>Try again</Button></p>}
      <RadioCardGroup ariaLabel="GitHub connection" value={connectionId} onValueChange={setConnectionId} disabled={save.isPending}
        options={connections.map(connection => ({ value: connection.id, title: connection.name }))} />
      {query.isSuccess && connections.length === 0 && <p className="text-sm text-muted-foreground">Connect GitHub to continue.</p>}
      <Button asChild variant="link" className="justify-start p-0"><Link to="/apps">Manage GitHub connections</Link></Button>
      {save.error && <p role="alert" className="text-sm text-destructive">{save.error instanceof ApiError && save.error.status === 409
        ? 'This source was updated. Your connection is still selected. Save again to apply it.' : save.error.message}</p>}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" disabled={save.isPending} onClick={onClose}>Cancel</Button>
        <Button disabled={!connectionId || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save connection'}</Button>
      </footer>
    </DialogContent>
  </Dialog>;
}
