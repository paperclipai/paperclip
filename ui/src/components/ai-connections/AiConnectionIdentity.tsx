import { useTranslation } from "@/i18n";
import { Building2, UserRound } from "lucide-react";
import { AppLogo } from "@/pages/apps/AppLogo";
import {
  AI_PROVIDERS,
  aiMethodLabel,
  type AiConnectionSummary,
} from "./model";

export function AiConnectionIdentity({
  connection,
}: {
  connection: AiConnectionSummary;
}) {
  const { t } = useTranslation("connections");
  const provider = AI_PROVIDERS[connection.provider];
  const Icon = connection.ownership === "shared" ? Building2 : UserRound;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <AppLogo name={provider.name} brandKey={connection.provider} logoUrl={provider.logo} size={24} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="break-words text-sm font-medium">
          {connection.name}
        </span>
        <span className="text-xs text-muted-foreground">
          {provider.name} ·{" "}
          {aiMethodLabel(connection.provider, connection.method)}
          {connection.accountLabel ? ` · ${connection.accountLabel}` : ""}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Icon aria-hidden className="size-3" />
          {connection.ownership === "shared"
            ? t("company_shared_62c7551")
            : t("personal_6cd45bd", { value: connection.ownerName ?? t("account_owner_75b7703") })}
        </span>
      </div>
    </div>
  );
}
