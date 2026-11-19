import { Building2, UserRound } from "lucide-react";
import { AppLogo } from "@/pages/apps/AppLogo";
import {
  AI_PROVIDERS,
  aiMethodLabel,
  type AiConnectionSummary,
} from "./model";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { cn } from "@/lib/utils";

export function AiConnectionIdentity({
  connection,
}: {
  connection: AiConnectionSummary;
}) {
  const provider = AI_PROVIDERS[connection.provider];
  const Icon = connection.ownership === "shared" ? Building2 : UserRound;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <AppLogo name={provider.name} brandKey={connection.provider} logoUrl={provider.logo} size={24} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className={cn("break-words text-sm font-medium", ANALYTICS_MASK_CLASS)}>
          {connection.name}
        </span>
        <span className={cn("text-xs text-muted-foreground", ANALYTICS_MASK_CLASS)}>
          {provider.name} ·{" "}
          {aiMethodLabel(connection.provider, connection.method)}
          {connection.accountLabel ? ` · ${connection.accountLabel}` : ""}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Icon aria-hidden className="size-3" />
          {connection.ownership === "shared"
            ? "Company shared"
            : `Personal · ${connection.ownerName ?? "Account owner"}`}
        </span>
      </div>
    </div>
  );
}
