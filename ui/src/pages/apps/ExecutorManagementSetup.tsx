import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import { aggregatorManagementUrl } from "@paperclipai/shared/aggregator-apps";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { useAccountIdentity } from "@/api/companies-query";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ExecutorManagementSetup({ connection, onClose }: { connection: ToolConnection; onClose: () => void }) {
  const [url, setUrl] = useState(typeof connection.config?.managementUrl === "string" ? connection.config?.managementUrl : "");
  const queries = useQueryClient();
  const { userId, settled } = useAccountIdentity();
  const save = useMutation({ mutationFn: async () => {
    const managementUrl = aggregatorManagementUrl("executor", url.trim());
    if (!managementUrl) throw new Error("Enter an HTTPS console URL without credentials.");
    await toolsApi.updateConnection(connection.id, { config: { ...connection.config, managementUrl } });
    await queries.invalidateQueries({ queryKey: queryKeys.tools.aggregatorApps(connection.id, userId) });
    const result = await toolsApi.syncAggregatorApps(connection.id, true);
    queries.setQueryData(queryKeys.tools.aggregatorApps(connection.id, userId), result);
  }, onSuccess: async () => { await queries.invalidateQueries({ queryKey: queryKeys.tools.connections(connection.companyId) }); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>Executor console</DialogTitle><DialogDescription>Choose where to manage accounts for “{connection.name}”. Include your workspace path.</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="space-y-2"><Label htmlFor="executor-console-url">Console URL</Label><Input id="executor-console-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} /></div>
      {save.error ? <p role="alert" className="text-sm text-destructive">{describeError(save.error).body}</p> : null}
      <DialogFooter className="sm:justify-between"><Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button type="submit" disabled={!settled || save.isPending || !url.trim()}>{save.isPending ? "Saving…" : "Save"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
