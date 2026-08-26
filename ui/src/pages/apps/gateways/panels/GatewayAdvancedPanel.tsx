import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { gatewaysQueryKey } from "../NewGatewayDialog";
import { t } from "@/i18n";

/**
 * Advanced tab — raw protocol/transport details, config JSON and the archive
 * (destructive) action live here, out of the default prosumer view per the
 * PAP-11174 contract's default-vs-Advanced split.
 */
export function GatewayAdvancedPanel({
  companyId,
  gateway,
}: {
  companyId: string;
  gateway: ToolMcpGatewayWithTokens;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}${gateway.endpointPath}`;
  const rawConfig = JSON.stringify(
    {
      gatewayPublicId: gateway.gatewayPublicId,
      displaySlug: gateway.displaySlug,
      status: gateway.status,
      profileId: gateway.profileId,
      defaultProfileMode: gateway.defaultProfileMode,
      contextScopeType: gateway.contextScopeType,
      contextScopeId: gateway.contextScopeId,
      endpointPath: gateway.endpointPath,
      authConfig: gateway.authConfig,
      headerPolicy: gateway.headerPolicy,
      metadataPolicy: gateway.metadataPolicy,
      onDemandToolsConfig: gateway.onDemandToolsConfig,
    },
    null,
    2,
  );

  const archiveMutation = useMutation({
    mutationFn: () => toolsApi.updateGateway(companyId, gateway.id, { status: "archived" }),
    onSuccess: async () => {
      pushToast({ title: t("app.gatewayAdvancedPanel.gatewayArchived", { defaultValue: "Gateway archived" }), body: `${gateway.name} is no longer reachable.`, tone: "success" });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(companyId) });
      navigate("/apps/gateways");
    },
    onError: (error) =>
      pushToast({
        title: t("app.gatewayAdvancedPanel.couldnTArchiveTheGateway", { defaultValue: "Couldn't archive the gateway" }),
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      }),
  });

  async function copy(value: string, label: string) {
    try {
      await copyTextToClipboard(value);
      pushToast({ title: t("app.gatewayAdvancedPanel.copied", { defaultValue: "Copied" }), body: label, tone: "success" });
    } catch {
      pushToast({ title: t("app.gatewayAdvancedPanel.copyFailed", { defaultValue: "Copy failed" }), body: "Clipboard access is unavailable.", tone: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">{t("app.gatewayAdvancedPanel.transport", { defaultValue: "Transport" })}</h3>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label={t("app.gatewayAdvancedPanel.transport", { defaultValue: "Transport" })} value="streamable_http" />
          <Row label={t("app.gatewayAdvancedPanel.authentication", { defaultValue: "Authentication" })} value="bearer" />
          <Row label={t("app.gatewayAdvancedPanel.protocolVersion", { defaultValue: "Protocol version" })} value="2025-03-26" />
          <Row label={t("app.gatewayAdvancedPanel.publicId", { defaultValue: "Public ID" })} value={gateway.gatewayPublicId} mono />
        </dl>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {endpoint}
          </code>
          <Button variant="outline" size="sm" onClick={() => void copy(endpoint, "Endpoint URL")}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            {t("common.copy", { defaultValue: "Copy" })}
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{t("app.gatewayAdvancedPanel.rawConfiguration", { defaultValue: "Raw configuration" })}</h3>
          <Button variant="outline" size="sm" onClick={() => void copy(rawConfig, "Gateway config JSON")}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            {t("app.gatewayAdvancedPanel.copyJson", { defaultValue: "Copy JSON" })}</Button>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
          {rawConfig}
        </pre>
      </section>

      <section className="space-y-2 rounded-lg border border-destructive/40 p-4">
        <h3 className="text-sm font-semibold text-destructive">{t("app.gatewayAdvancedPanel.dangerZone", { defaultValue: "Danger zone" })}</h3>
        <p className="text-sm text-muted-foreground">
          {t("app.gatewayAdvancedPanel.archivingTakesTheGatewayOfflineForEveryClientExistingTokensStopWorkingTypeTheGatewayNameToConfirm", { defaultValue: "Archiving takes the gateway offline for every client. Existing tokens stop working. Type the gateway name to confirm." })}</p>
        {confirming ? (
          <div className="space-y-2">
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={gateway.name}
              aria-label={t("app.gatewayAdvancedPanel.typeTheGatewayNameToConfirmArchive", { defaultValue: "Type the gateway name to confirm archive" })}
            />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={confirmName.trim() !== gateway.name || archiveMutation.isPending}
                onClick={() => archiveMutation.mutate()}
              >
                {archiveMutation.isPending ? "Archiving…" : t("app.gatewayAdvancedPanel.archiveGateway", { defaultValue: "Archive gateway" })}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setConfirming(false); setConfirmName(""); }}>
                {t("common.cancel", { defaultValue: "Cancel" })}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirming(true)}>
            {t("app.gatewayAdvancedPanel.archiveGateway", { defaultValue: "Archive gateway" })}</Button>
        )}
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-foreground" : "mt-0.5 text-foreground"}>{value}</dd>
    </div>
  );
}
