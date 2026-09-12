import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";

export function AiConnectionLegacyNotice({
  onAdopt,
  readOnly = false,
}: {
  onAdopt: () => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">
        {t("sep13Connections.legacyTitle")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t("sep13Connections.legacyDescription")}
      </p>
      {!readOnly && (
        <Button variant="outline" className="h-auto max-w-full self-start whitespace-normal" onClick={onAdopt}>
          {t("sep13Connections.chooseManaged")}
        </Button>
      )}
    </div>
  );
}
