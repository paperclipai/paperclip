import { useTranslation, t } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { AiConnectionPoolConnector } from "@/components/ai-connections/AiConnectionPoolConnector";
import { useEffect } from "react";
import { isRetiredComposioConnection } from "@paperclipai/shared";
import { findComposioCatalogApp } from "@paperclipai/shared/aggregator-app-catalog";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { aiProviderSetupPreset, type ToolConnectionCredentialSource } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useParams, useSearchParams } from "@/lib/router";
import { consumeSkillSourceReturn, skillSourceReturnPath } from "@/lib/skill-source-connect-return";

export { AccessStep, OAuthConnectStateScreen, type OAuthConnectPhase } from "@/features/connections/ConnectionSetupFlow";

/** Full-page host for the same setup used by inline connection requests. */
export function AppsConnect({ byoOnly = false, credentialSource = "paperclip_vault" }: {
  byoOnly?: boolean;
  credentialSource?: ToolConnectionCredentialSource;
} = {}) {
  useTranslation();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { appKey } = useParams<{ appKey?: string }>();
  const source = searchParams.get("source") ?? appKey ?? searchParams.get("appKey");
  const reconnectId = searchParams.get("reconnect");
  const preset = aiProviderSetupPreset(source);
  const aiReconnectRequested = Boolean(reconnectId && (preset || ["openai", "anthropic", "xai"].includes(source ?? "")));
  const aiAccounts = useQuery({ queryKey: ["ai-connections", selectedCompanyId], queryFn: () => aiConnectionsApi.list(selectedCompanyId!), enabled: Boolean(selectedCompanyId && aiReconnectRequested) });
  const aiReconnect = aiAccounts.data?.connections.find(c => c.id === reconnectId);
  const gallery = useQuery({ queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"), queryFn: () => toolsApi.listGallery(selectedCompanyId!), enabled: !!selectedCompanyId && !!source?.startsWith("ai-router-") });
  const router = gallery.data?.apps.find(app => app.slug === source)?.aiConnectionRouter;
  const toolkit = searchParams.get("targetToolkit");
  const reuseComposio = source === "composio" && Boolean(toolkit && findComposioCatalogApp(toolkit))
    && searchParams.get("new") !== "1" && !searchParams.get("resume") && !searchParams.get("reconnect")
    && !byoOnly && credentialSource === "paperclip_vault";
  const saved = useQuery({ queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!), enabled: reuseComposio && Boolean(selectedCompanyId), retry: false });
  const hasSavedComposio = reuseComposio && saved.data?.connections.some(connection =>
    connection.config?.sourceTemplateKey === "composio" && connection.transport === "mcp_remote"
    && connection.status === "active" && connection.enabled && !isRetiredComposioConnection(connection));
  useEffect(() => {
    if (hasSavedComposio) navigate(`/apps?source=composio&targetToolkit=${encodeURIComponent(toolkit!)}`, { replace: true });
  }, [hasSavedComposio, toolkit, navigate]);
  if (reuseComposio && selectedCompanyId && (saved.isPending || hasSavedComposio)) return <p role="status" className="text-sm text-muted-foreground">{t("oct6Beta.copy207")}</p>;
  if (reuseComposio && saved.isError) return <div className="space-y-3">
    <p role="alert" className="text-sm text-destructive">{t("oct6Beta.copy208")}</p>
    <div className="flex items-center justify-between"><Button variant="ghost" onClick={() => navigate("/apps")}>{t("oct5Core.s0345")}</Button><Button onClick={() => void saved.refetch()}>{t("oct5Core.s0057")}</Button></div>
  </div>;
  const returningToSkills = source === "github" && selectedCompanyId && skillSourceReturnPath(selectedCompanyId);
  function returnToSkills() {
    const path = selectedCompanyId && consumeSkillSourceReturn(selectedCompanyId);
    if (path) navigate(path);
  }
  if (aiReconnectRequested && aiAccounts.isPending) return <p role="status">{t("chatUi.chatEndpointDetail.loadingConnection")}</p>;
  if (aiReconnectRequested && aiAccounts.isError) return <p role="alert">{t("oct6Beta.copy209")}</p>;
  if (aiReconnectRequested && !aiReconnect) return <p role="alert">{t("oct6Beta.copy210")}</p>;
  if (selectedCompanyId && (preset || aiReconnect?.routing)) return (
    <AiProviderSetup
      key={reconnectId ?? source}
      companyId={selectedCompanyId}
      reconnect={aiReconnect}
      initialProvider={preset?.provider}
      initialProtocol={preset?.protocol}
      providerLabel={preset?.label}
      onCancel={() => navigate("/apps")}
      onComplete={binding => navigate(`/apps/${binding.connectionId}/permissions`)}
    />
  );
  if (source?.startsWith("ai-router-")) {
    if (gallery.isPending) return <p role="status">{t("oct6Beta.copy211")}</p>;
    if (!router) return <p role="alert">{gallery.error?.message ?? t("oct6Beta.copy212")}</p>;
    return <AiConnectionPoolConnector pluginKey={router.pluginKey} />;
  }
  return <ConnectionSetupFlow byoOnly={byoOnly} credentialSource={credentialSource} host="page"
    onComplete={returningToSkills ? returnToSkills : undefined}
    onCancel={returningToSkills ? returnToSkills : undefined} />;
}
