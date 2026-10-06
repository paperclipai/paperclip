import { useTranslation } from "@/i18n";
import { Copy } from "lucide-react";
import type { ToolMcpGatewayWithTokens, ToolProfileWithDetails } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  activeTokenCount,
  allowedToolsLabel,
  expiringTokenCount,
  formatScope,
  type GatewayAppRow,
  gatewayAppDisplayName,
  isGatewayOn,
} from "../gateway-helpers";

export function OverviewPanel({
  gateway,
  profile,
  apps,
  agentNames,
  projectNames,
  toggleDisabled,
  onToggle,
}: {
  gateway: ToolMcpGatewayWithTokens;
  profile: ToolProfileWithDetails | undefined;
  apps: GatewayAppRow[];
  agentNames: Map<string, string>;
  projectNames: Map<string, string>;
  toggleDisabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}${gateway.endpointPath}`;
  const active = activeTokenCount(gateway);
  const expiring = expiringTokenCount(gateway);
  const needsAttention = apps.filter((app) => app.needsAttention);
  const on = isGatewayOn(gateway);

  const snippet = [
    "{",
    '  "mcpServers": {',
    `    "paperclip-${gateway.displaySlug}": {`,
    `      "url": "${endpoint}",`,
    '      "headers": { "Authorization": "Bearer pcgw_•••_TOKEN" }',
    "    }",
    "  }",
    "}",
  ].join("\n");

  async function copy(value: string, label: string) {
    try {
      await copyTextToClipboard(value);
      pushToast({ title: t("pages.agentDetail.copied"), body: label, tone: "success" });
    } catch {
      pushToast({ title: t("pages.agentDetail.copyFailed"), body: t("pages.agentDetail.clipboardUnavailable"), tone: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border p-4">
          <div className="text-xs font-medium text-muted-foreground">{on ? t("pages.instanceSettings.on") : t("pages.instanceSettings.off")}</div>
          <div className="mt-2">
            <ToggleSwitch checked={on} disabled={toggleDisabled} onCheckedChange={onToggle} aria-label={t("localizationApps.toggleGateway243")} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("localizationApps.toggleTheWholeGatewayOffHere244")}</p>
        </div>
        <StatCard label={t("nav.apps")}>
          {t("localizationApps.appCount", { count: apps.length })}
          {profile ? ` · ${allowedToolsLabel(profile)}` : ""}
        </StatCard>
        <StatCard label={t("pages.userProfile.tokens")}>
          {t("localizationApps.activeCount", { count: active })}{expiring > 0 ? t("localizationApps.expiringCount", { count: expiring }) : ""}
        </StatCard>
        <StatCard label={t("localizationApps.health248")}>
          {needsAttention.length === 0 ? t("localizationApps.allGreen249") : t("localizationApps.needsAttentionCount", { count: needsAttention.length })}
        </StatCard>
      </div>

      <section className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t("localizationApps.whoCanUseIt251")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("localizationApps.anyoneHoldingAnActiveTokenBelowRestrictedByTh252")}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip>{t("localizationApps.scopeValue", { scope: formatScope(gateway, projectNames, agentNames) })}</Chip>
          <Chip>{t("localizationApps.profileValue", { profile: profile?.name ?? t("localizationConnections.unavailable93") })}</Chip>
          <Chip>{t("localizationApps.activeTokens", { count: active })}</Chip>
        </div>
      </section>

      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-foreground">{t("localizationApps.appsInThisGateway255")}</h3>
        {apps.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("localizationApps.thisGatewaySProfileDoesnTIncludeAnyAppsYet256")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {apps.map((app) => (
              <AppRow key={app.application.id} app={app} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t("localizationApps.howClientsConnect257")}</h3>
          <Button variant="outline" size="sm" onClick={() => void copy(snippet, t("localizationApps.clientConfig258"))}>
            <Copy className="mr-1 h-3.5 w-3.5" />{t("pages.apps.common.copy")}</Button>
        </div>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono text-xs text-muted-foreground">
          {snippet}
        </pre>
      </section>
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  useTranslation();
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

function AppRow({ app }: { app: GatewayAppRow }) {
  const { t } = useTranslation();
  const href = app.connection
    ? `/apps/${app.connection.id}/permissions`
    : `/apps/app/${app.application.id}/permissions`;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <Link to={href} className="font-medium text-foreground hover:underline">
          {gatewayAppDisplayName(app)}
        </Link>
        <div className="text-xs text-muted-foreground">
          {t("localizationApps.toolCount", { count: app.toolCount })}
          {app.needsAttention && app.attentionReason ? ` · ${app.attentionReason}` : ""}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
          app.needsAttention
            ? "border-foreground bg-foreground text-background"
            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        {app.needsAttention ? t("pages.apps.connections.statusNeedsAttention") : t("pages.apps.connections.statusHealthy")}
      </span>
    </li>
  );
}
