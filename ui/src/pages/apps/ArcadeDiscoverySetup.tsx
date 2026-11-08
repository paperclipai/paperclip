import { Trans } from "react-i18next";
import { useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { useAccountIdentity } from "@/api/companies-query";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ToolConnection } from "@paperclipai/shared";

export function ArcadeDiscoverySetup({ connection, onClose }: { connection: ToolConnection; onClose: () => void }) {
  const { t } = useTranslation("connections");
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
    <DialogHeader><DialogTitle>{t("sync_arcade_accounts_ca59b44")}</DialogTitle>
      <DialogDescription>{t("see_apps_available_through_your_gateway_works_9842bec", { name: connection.name })}</DialogDescription>
    </DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="space-y-2"><Label htmlFor="arcade-discovery-key">{t("project_api_key_c5a01e6")}</Label>
        <p className="text-xs text-muted-foreground"><Trans ns="connections" i18nKey="reviewBArcadeKeyInstructions" components={{ arcade: <a className="underline" href="https://app.arcade.dev" target="_blank" rel="noopener noreferrer" /> }} /></p>
        <Input id="arcade-discovery-key" type="password" autoComplete="off" required value={apiKey} onChange={event => setApiKey(event.target.value)} />
      </div>
      <div className="space-y-2"><Label htmlFor="arcade-discovery-user">{t("arcade_user_id_aff47d0")}</Label>
        <p className="text-xs text-muted-foreground">{t("use_the_end_user_id_configured_for_f5c6f35")}</p>
        <Input id="arcade-discovery-user" autoComplete="off" required value={userId} onChange={event => setUserId(event.target.value)} />
      </div>
      {save.error ? <p role="alert" className="text-sm text-destructive">{describeError(save.error).body}</p> : null}
      <DialogFooter className="sm:justify-between"><Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>{t("cancel_77dfd21")}</Button>
        <Button type="submit" disabled={!settled || save.isPending || !apiKey.trim() || !userId.trim()}>{save.isPending ? t("saving_56a2285") : t("save_and_sync_d3d676a")}</Button>
      </DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
