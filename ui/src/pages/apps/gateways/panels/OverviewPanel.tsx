import { t as finalPagesT } from "@/i18n";
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
  const { t } = useTranslation("connections");
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
      pushToast({ title: t("copied_8e3df45"), body: label, tone: "success" });
    } catch {
      pushToast({ title: t("copy_failed_bd5acbf"), body: t("clipboard_access_is_unavailable_0d01be9"), tone: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border p-4">
          <div className="text-xs font-medium text-muted-foreground">{on ? t("on_e0049a6") : t("off_e3de5ab")}</div>
          <div className="mt-2">
            <ToggleSwitch checked={on} disabled={toggleDisabled} onCheckedChange={onToggle} aria-label={t("toggle_gateway_305e547")} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("toggle_the_whole_gateway_off_here_1ecfce4")}</p>
        </div>
        <StatCard label={t("apps_d9a3685")}>
          {finalPagesT("final-pages:apps", { count: apps.length })}
          {profile ? ` · ${allowedToolsLabel(profile)}` : ""}
        </StatCard>
        <StatCard label={t("tokens_c38c6c1")}>
          {finalPagesT("final-pages:count_active_480255", { count: active })}{expiring > 0 ? t("expiring_3773ba7", { expiring: expiring }) : ""}
        </StatCard>
        <StatCard label={t("health_3703cd2")}>
          {needsAttention.length === 0 ? t("all_green_7edcca2") : t("needs_attention_8e3aa72", { length: needsAttention.length })}
        </StatCard>
      </div>

      <section className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t("who_can_use_it_127d997")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("anyone_holding_an_active_token_below_restricted_e0acfe8")}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip>{t("scope_ca56e6e", { value: formatScope(gateway, projectNames, agentNames) })}</Chip>
          <Chip>{t("profile_baae00c", { profileName: profile?.name ?? t("reviewBUnavailable") })}</Chip>
          <Chip>{finalPagesT("final-pages:activeTokens", { count: active })}</Chip>
        </div>
      </section>

      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-foreground">{t("apps_in_this_gateway_2a40cd7")}</h3>
        {apps.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("this_gateway_s_profile_doesn_t_include_2c276ef")}</p>
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
          <h3 className="text-sm font-semibold text-foreground">{t("how_clients_connect_ad8a858")}</h3>
          <Button variant="outline" size="sm" onClick={() => void copy(snippet, "Client config")}>
            <Copy className="mr-1 h-3.5 w-3.5" />{t("copy_7c39cf0")}</Button>
        </div>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono text-xs text-muted-foreground">
          {snippet}
        </pre>
      </section>
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

function AppRow({ app }: { app: GatewayAppRow }) {
  const { t } = useTranslation("connections");
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
          {finalPagesT("final-pages:tools", { count: app.toolCount })}
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
        {app.needsAttention ? t("needs_attention_a126722") : t("healthy_80ea156")}
      </span>
    </li>
  );
}
