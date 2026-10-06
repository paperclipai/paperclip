import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toolsApi } from "@/api/tools";
import { useAccountIdentity } from "@/api/companies-query";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ToolConnection } from "@paperclipai/shared";

export function ArcadeDiscoverySetup({ connection, onClose }: { connection: ToolConnection; onClose: () => void }) {
  useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [userId, setUserId] = useState("");
  const queries = useQueryClient();
  const { userId: viewingUserId, settled } = useAccountIdentity();
  const save = useMutation({ mutationFn: async () => {
      const result = await toolsApi.configureArcadeDiscovery(connection.id, { apiKey: apiKey.trim(), userId: userId.trim() });
      queries.setQueryData(queryKeys.tools.aggregatorApps(connection.id, viewingUserId), result);
    },
    onSuccess: onClose,
  });
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t("oct6Beta.copy213")}</DialogTitle>
      <DialogDescription>{t("oct6Beta.arcadeDiscoveryDescription", { name: connection.name })}</DialogDescription>
    </DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="space-y-2"><Label htmlFor="arcade-discovery-key">{t("oct6Beta.copy214")}</Label>
        <p className="text-xs text-muted-foreground"><Trans i18nKey="oct6Beta.arcadeDiscoveryKey" components={{ arcade: <a className="underline" href="https://app.arcade.dev" target="_blank" rel="noopener noreferrer" /> }} /></p>
        <Input id="arcade-discovery-key" type="password" autoComplete="off" required value={apiKey} onChange={event => setApiKey(event.target.value)} />
      </div>
      <div className="space-y-2"><Label htmlFor="arcade-discovery-user">{t("oct6Beta.copy215")}</Label>
        <p className="text-xs text-muted-foreground">{t("oct6Beta.copy216")}</p>
        <Input id="arcade-discovery-user" autoComplete="off" required value={userId} onChange={event => setUserId(event.target.value)} />
      </div>
      {save.isError ? <p role="alert" className="text-sm text-destructive">{save.error instanceof Error ? save.error.message : t("oct6Beta.copy217")}</p> : null}
      <DialogFooter className="sm:justify-between"><Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>{t("oct5Core.s0345")}</Button>
        <Button type="submit" disabled={!settled || save.isPending || !apiKey.trim() || !userId.trim()}>{save.isPending ? t("oct5Core.s0466") : t("oct6Beta.copy218")}</Button>
      </DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
