import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation("connections");
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">
          {upstreamServiceName
            ? t("connect_through_1278773", { upstreamServiceName: upstreamServiceName, providerName: providerName })
            : t("connect_aa9bb86", { providerName: providerName })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("use_an_existing_connection_or_connect_a_6ff77ec")}</p>
      </div>
      {upstreamServiceName && (
        <InlineBanner compact>{t("is_an_external_service_that_handles_the_4be6776", { providerName: providerName, upstreamServiceName: upstreamServiceName })}</InlineBanner>
      )}
      <ConnectionChoiceList
        choices={connections.map((connection) => ({
          ...connection,
          description: t("final-configuration:providerAccount"),
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
        >{t("cancel_1791a62")}</Button>
        <Button disabled={Boolean(pendingId)} onClick={onConnectNew}>{t("connect_new_01e7629")}</Button>
      </div>
    </div>
  );
}
