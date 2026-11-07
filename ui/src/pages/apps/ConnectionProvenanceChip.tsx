import { useTranslation } from "@/i18n";
import { Blocks } from "lucide-react";
import { cn } from "@/lib/utils";

export function ConnectionProvenanceChip({
  connection,
  className,
}: {
  connection: {
    config?: Record<string, unknown> | null;
    credentialSource?: string;
    externalCredential?: { connectorUid?: string } | null;
  } | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation("connections");
  const chipClass = cn(
    "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
    className,
  );
  if (connection?.credentialSource === "vercel_connect") {
    const connectorUid = connection.externalCredential?.connectorUid;
    return (
      <span
        className={chipClass}
        title={connectorUid ? t("credentials_managed_by_vercel_connect_26fe984", { connectorUid: connectorUid }) : t("credentials_managed_by_vercel_connect_51ac862")}
      >
        <Blocks className="h-3 w-3" />{t("via_vercel_connect_8c26198")}</span>
    );
  }

  return null;
}
