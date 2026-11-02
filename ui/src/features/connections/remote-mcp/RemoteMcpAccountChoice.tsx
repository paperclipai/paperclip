import { t, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/InlineBanner";
import { ConnectionChoiceList } from "../ConnectionChoiceList";

/** Shared presentation for account reuse, including the requested external app. */
export function RemoteMcpAccountChoice({
  providerName,
  upstreamServiceName,
  connections,
  pendingId,
  error,
  onSelect,
  onCancel,
  onConnectNew,
}: {
  providerName: string;
  upstreamServiceName?: string;
  connections: { id: string; name: string }[];
  pendingId?: string | null;
  error?: string | null;
  onSelect: (id: string) => void;
  onCancel?: () => void;
  onConnectNew: () => void;
}) {
  useTranslation();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">
          {upstreamServiceName
            ? t("sep28Apps.connectThrough", { service: upstreamServiceName, provider: providerName })
            : t("localizationConnections.connectApp", { app: providerName })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("sep28Apps.existingConnection")}</p>
      </div>
      {upstreamServiceName && (
        <InlineBanner compact>
          {t("sep28Apps.externalReuse", { provider: providerName, service: upstreamServiceName })}
        </InlineBanner>
      )}
      <ConnectionChoiceList
        choices={connections.map((connection) => ({
          ...connection,
          description: t("sep28Apps.providerAccount"),
        }))}
        pendingId={pendingId}
        onSelect={onSelect}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          disabled={Boolean(pendingId)}
          onClick={onCancel}
        >{t("sep28Routines.cancel")}</Button>
        <Button disabled={Boolean(pendingId)} onClick={onConnectNew}>{t("localizationConnections.connectNew48")}</Button>
      </div>
    </div>
  );
}
