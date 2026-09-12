import { useTranslation } from "@/i18n";
import { chatUiErrorMessage, type ChatUiError } from "@/pages/apps/chat/chat-copy";
import { useState, type ReactNode } from "react";
import { CheckCircle2, RefreshCw, Star, TriangleAlert, Unplug } from "lucide-react";
import type { ConnectionGrant } from "@paperclipai/shared";
import { RevokeGrantDialog } from "@/pages/apps/app-detail/IdentitiesSection";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { aiMethodLabel, type AiConnectionSummary } from "./model";

/** AI-only account controls; identity, access and navigation belong to AppDetail. */
export function AiConnectionAccountControls({
  account, grant, currentUserId, readOnly, onMakeDefault, onReconnect, onRevoke, revocationDetails,
}: {
  account: AiConnectionSummary;
  grant: ConnectionGrant;
  currentUserId: string;
  readOnly?: boolean;
  onMakeDefault: () => void;
  onReconnect: () => void;
  onRevoke: () => void | Promise<void>;
  revocationDetails?: ReactNode;
}) {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState(false);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<ChatUiError>();
  const ownPersonal = account.ownership === "personal" && account.ownerUserId === currentUserId;
  const available = account.status === "connected";
  const activeDefault = account.isDefault && available;
  return (
    <section className="space-y-4" aria-label={t("sep13Connections.accountSettings")}>
      {ownPersonal && (
        <div className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3",
          activeDefault && "border-(--status-task-done)/30 bg-(--status-task-done)/5",
        )}>
          <div className="flex items-center gap-3">
            <Star aria-hidden className={cn("size-5 shrink-0", activeDefault ? "fill-current text-(--status-task-icon-done)" : "text-muted-foreground")} />
            <div>
              <h3 className="text-sm font-semibold">{t("sep13Connections.personalDefault")}</h3>
              <p className="text-xs text-muted-foreground">{aiMethodLabel(account.provider, account.method)}</p>
            </div>
          </div>
          {account.isDefault ? (
            <span role="status" className={cn("inline-flex items-center gap-1.5 text-sm font-medium", available ? "text-(--status-task-icon-done)" : "text-destructive")}>
              {available ? <CheckCircle2 className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}
              {available ? t("sep13Connections.yourDefault") : t("sep13Connections.defaultUnavailable")}
            </span>
          ) : !readOnly ? (
            <Button variant="outline" size="sm" disabled={!available} onClick={onMakeDefault}>{t("sep13Connections.makeDefault")}</Button>
          ) : <span className="text-xs text-muted-foreground">{t("sep13Connections.notYourDefault")}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{aiMethodLabel(account.provider, account.method)}</p>
          {account.accountLabel && <p className="break-words text-xs text-muted-foreground">{account.accountLabel}</p>}
        </div>
        {!readOnly && grant.capabilities?.canRevoke && (
          <div className="flex flex-wrap items-center gap-2">
            {<Button variant="outline" size="sm" onClick={onReconnect}><RefreshCw className="size-4" aria-hidden />{t("sep13Connections.reconnect")}</Button>}
            {account.status !== "revoked" && <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(true)}><Unplug className="size-4" aria-hidden />{t("sep13Connections.revokeIdentity")}</Button>}
          </div>
        )}
      </div>
      {revoking && <RevokeGrantDialog grant={grant} providerName={account.name} pending={revokePending} credentialPolicy={account.ownership === "shared" ? "shared" : "per_user"} isOwnIdentity={account.ownerUserId === currentUserId}
        description={t("sep13Connections.revokeDescription")}
        onCancel={() => setRevoking(false)} onConfirm={async () => { setRevokePending(true); setRevokeError(undefined); try { await onRevoke(); setRevoking(false); } catch (error) { setRevokeError(error instanceof Error ? error.message : { key: "sep13Connections.revokeError" }); } finally { setRevokePending(false); } }}>{revokeError && <p role="alert" className="text-sm text-destructive">{chatUiErrorMessage(revokeError)}</p>}{revocationDetails}</RevokeGrantDialog>}
    </section>
  );
}
