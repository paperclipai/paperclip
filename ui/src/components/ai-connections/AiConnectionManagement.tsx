import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";

export function AiConnectionLegacyNotice({
  onAdopt,
  readOnly = false,
}: {
  onAdopt: () => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation("connections");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">{t("existing_authentication_not_managed_by_connections_9d6f3d2")}</h3>
      <p className="text-sm text-muted-foreground">{t("this_agent_keeps_its_current_authentication_until_fa8b875")}</p>
      {!readOnly && (
        <Button variant="outline" className="self-start" onClick={onAdopt}>{t("choose_a_managed_connection_1d4634a")}</Button>
      )}
    </div>
  );
}
