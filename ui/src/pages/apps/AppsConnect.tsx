import { useQuery } from "@tanstack/react-query";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { AiConnectionPoolConnector } from "@/components/ai-connections/AiConnectionPoolConnector";
import { useEffect } from "react";
import { isRetiredComposioConnection } from "@paperclipai/shared";
import { findComposioCatalogApp } from "@paperclipai/shared/aggregator-app-catalog";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
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
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { appKey } = useParams<{ appKey?: string }>();
  const source = searchParams.get("source") ?? appKey ?? searchParams.get("appKey");
  const reconnectId = searchParams.get("reconnect");
  const preset = aiProviderSetupPreset(source);
  const aiReconnectRequested = Boolean(reconnectId && (preset || ["openai", "anthropic", "xai"].includes(source ?? "")));
  const aiAccounts = useQuery({ queryKey: ["ai-connections", selectedCompanyId], queryFn: () => aiConnectionsApi.list(selectedCompanyId!), enabled: Boolean(selectedCompanyId && aiReconnectRequested) });
  const aiAccountsView = useQueryView(aiAccounts);
  const aiReconnect = aiAccounts.data?.connections.find(c => c.id === reconnectId);
  const gallery = useQuery({ queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"), queryFn: () => toolsApi.listGallery(selectedCompanyId!), enabled: !!selectedCompanyId && !!source?.startsWith("ai-router-") });
  const galleryView = useQueryView(gallery);
  const router = gallery.data?.apps.find(app => app.slug === source)?.aiConnectionRouter;
  const toolkit = searchParams.get("targetToolkit");
  const reuseComposio = source === "composio" && Boolean(toolkit && findComposioCatalogApp(toolkit))
    && searchParams.get("new") !== "1" && !searchParams.get("resume") && !searchParams.get("reconnect")
    && !byoOnly && credentialSource === "paperclip_vault";
  const saved = useQuery({ queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!), enabled: reuseComposio && Boolean(selectedCompanyId) });
  const savedView = useQueryView(saved);
  const hasSavedComposio = reuseComposio && saved.data?.connections.some(connection =>
    connection.config?.sourceTemplateKey === "composio" && connection.transport === "mcp_remote"
    && connection.status === "active" && connection.enabled && !isRetiredComposioConnection(connection));
  useEffect(() => {
    if (hasSavedComposio) navigate(`/apps?source=composio&targetToolkit=${encodeURIComponent(toolkit!)}`, { replace: true });
  }, [hasSavedComposio, toolkit, navigate]);
  if (reuseComposio && selectedCompanyId && (saved.isPending || savedView.kind === "reconnecting" || hasSavedComposio)) return <p role="status" className="text-sm text-muted-foreground">Checking saved Composio accounts…</p>;
  if (reuseComposio && savedView.kind === "error") return <div className="space-y-3">
    <QueryErrorState error={saved.error} action="load your Composio accounts" onRetry={savedView.retry} retrying={savedView.isFetching} />
    <Button variant="ghost" onClick={() => navigate("/apps")}>Cancel</Button>
  </div>;
  const returningToSkills = source === "github" && selectedCompanyId && skillSourceReturnPath(selectedCompanyId);
  function returnToSkills() {
    const path = selectedCompanyId && consumeSkillSourceReturn(selectedCompanyId);
    if (path) navigate(path);
  }
  if (aiReconnectRequested && (aiAccounts.isPending || aiAccountsView.kind === "reconnecting")) return <p role="status">Loading connection…</p>;
  if (aiReconnectRequested && aiAccountsView.kind === "error") return <QueryErrorState error={aiAccounts.error} action="load this connection" onRetry={aiAccountsView.retry} retrying={aiAccountsView.isFetching} />;
  if (aiReconnectRequested && !aiReconnect) return <p role="alert">This connection is unavailable. Return to Connectors to choose an account.</p>;
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
    if (gallery.isPending || galleryView.kind === "reconnecting") return <p role="status">Loading connector…</p>;
    if (galleryView.kind === "error") return <QueryErrorState error={gallery.error} action="load the connector" onRetry={galleryView.retry} retrying={galleryView.isFetching} />;
    if (!router) return <p role="alert">This connection pool plugin is unavailable. Enable it in Plugins.</p>;
    return <AiConnectionPoolConnector pluginKey={router.pluginKey} />;
  }
  return <ConnectionSetupFlow byoOnly={byoOnly} credentialSource={credentialSource} host="page"
    onComplete={returningToSkills ? returnToSkills : undefined}
    onCancel={returningToSkills ? returnToSkills : undefined} />;
}
