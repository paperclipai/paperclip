import { chatUiErrorMessage, type ChatUiError } from "@/pages/apps/chat/chat-copy";
import { t, useTranslation } from "@/i18n";
import { ConnectionInstructionsEditor } from "../ConnectionInstructions";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAppAggregator, aggregatorManagementUrl } from "@paperclipai/shared/aggregator-apps";
import { REMOTE_MCP_CONNECTOR_METHODS, defaultConnectionAgentInstructions, getConnectableAppDefinition, type ToolConnection } from "@paperclipai/shared";
import { askFirstCatalogEntryIdsFor } from "../connection-defaults";
import { RemoteMcpAccountChoice } from "./RemoteMcpAccountChoice";
import { readConnectionIntentOAuthOutcome, type ConnectionSetupFlowProps } from "../ConnectionSetupFlow";
import { agentsApi } from "@/api/agents";
import { toolsApi } from "@/api/tools";
import { resolveAccountUserId } from "@/api/companies-query";
import { useCompany } from "@/context/CompanyContext";
import { findAggregatorApp } from "@paperclipai/shared/aggregator-app-catalog";
import { useNavigate, useSearchParams } from "@/lib/router";
import { resolveAuthorizationTarget } from "@/lib/authorizationUrl";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { queryKeys } from "@/lib/queryKeys";
import { RemoteMcpConnectionSetup } from "./RemoteMcpConnectionSetup";
import { remoteMcpProviders, type RemoteMcpProviderId } from "./providers";
import type { RemoteMcpSetupActions, RemoteMcpSetupState } from "./types";

class HeaderInputError extends Error {}

function readAccessDraft(key: string): Partial<RemoteMcpSetupState> {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || !["organization", "user"].includes(value.grantKind) || typeof value.allAgents !== "boolean" || !Array.isArray(value.agentIds)) return {};
    return { grantKind: value.grantKind, allAgents: value.allAgents, agentIds: value.agentIds.filter((id: unknown) => typeof id === "string") };
  } catch { return {}; }
}

export function RemoteMcpProductionSetup({ providerId, connection, host = "page", interactionId,
  upstreamServiceName, requestedAgentId, existingConnections = [], forceNewConnection, onUseExisting, onComplete, onCancel, onPhaseChange,
}: ConnectionSetupFlowProps & { providerId: RemoteMcpProviderId; connection?: ToolConnection }) {
  useTranslation();
  const provider = remoteMcpProviders[providerId];
  const template = getConnectableAppDefinition(providerId)?.agentInstructions;
  const [instructions, setInstructions] = useState(() => connection
    ? connection.agentInstructions ?? (template ? { ...defaultConnectionAgentInstructions(template)!, enabled: false } : null)
    : defaultConnectionAgentInstructions(template));
  const instructionsValid = !instructions || Boolean(instructions.text.trim());
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  let targetToolkit = searchParams.get("targetToolkit");
  if (!targetToolkit && connection && host === "page") {
    try { targetToolkit = sessionStorage.getItem(`paperclip:mcp-upstream-app:${selectedCompanyId}:${connection.id}`); } catch { /* Storage may be disabled. */ }
  }
  const targetApp = findAggregatorApp(providerId, targetToolkit);
  const targetRoute = targetApp?.routes.find((route) => route.provider === providerId);
  upstreamServiceName ??= targetApp?.name;
  const oauthOutcome = connection ? searchParams.get("oauth") : null;
  const queries = useQueryClient();
  const accessDraftKey = `paperclip:mcp-access-draft:${selectedCompanyId}:${interactionId || providerId}`;
  const intentDraftKey = `paperclip:mcp-intent-draft:${selectedCompanyId}:${interactionId}`;
  const popup = useRef<Window | null>(null);
  useEffect(() => () => {
    popup.current?.close();
    popup.current = null;
  }, []);
  const [showChoices, setShowChoices] = useState(!connection && !forceNewConnection && existingConnections.length > 0 && Boolean(onUseExisting));
  const [choicePending, setChoicePending] = useState<string | null>(null);
  const [choiceError, setChoiceError] = useState<ChatUiError | null>(null);
  const savedConnection = useRef(connection);
  const busy = useRef(false);
  const authorizationUrl = useRef<string | undefined>(undefined);
  const [state, setState] = useState<RemoteMcpSetupState>(() => ({
    // PAP-659 C0: there is no Access step on the way in. The resolved default
    // is stated on the connect screen and changed in its Advanced disclosure;
    // `access` survives only as a management screen reached after connecting.
    step: "connect", grantKind: connection ? connection.credentialPolicy === "per_user" ? "user" : "organization" : requestedAgentId ? "user" : "organization",
    setupComplete: Boolean(connection && connection.status !== "draft"),
    url: typeof connection?.config?.url === "string" ? connection.config?.url : provider.defaultUrl,
    managementUrl: typeof connection?.config?.managementUrl === "string" ? connection.config.managementUrl : "",
    auth: connection?.config?.mcpAuthMode === "bearer" ? "bearer" : connection?.authKind === "api_key" ? "headers" : provider.supportsBrowserAuth ? "auto" : "none",
    token: "", headers: [], connectStatus: oauthOutcome === "denied" ? "cancelled" : oauthOutcome === "failed" ? "oauth_failed" : "idle", connected: false,
    identity: null, allAgents: true, agentIds: [], permissions: {}, tools: [], notice: connection?.authKind === "api_key" ? { key: "sep28Apps.savedCredentials" } : null, refreshing: false,
    ...(!connection ? readAccessDraft(accessDraftKey) : {}),
    ...(requestedAgentId ? { allAgents: false, agentIds: [requestedAgentId] } : {}),
  }));
  const installs = useQuery({ queryKey: queryKeys.tools.connectionInstalls(connection?.id ?? "__new__"), queryFn: () => toolsApi.getConnectionInstalls(connection!.id), enabled: !!connection });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!), queryFn: () => agentsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId,
  });
  useEffect(() => {
    if (installs.data && !requestedAgentId) setState((s) => ({ ...s, allAgents: installs.data.installs.some((i) => i.targetType === "company"), agentIds: installs.data.installs.filter((i) => i.targetType === "agent").map((i) => i.targetId) }));
  }, [installs.data, requestedAgentId]);
  useEffect(() => {
    if (connection) return;
    try { sessionStorage.setItem(accessDraftKey, JSON.stringify({ grantKind: state.grantKind, allAgents: state.allAgents, agentIds: state.agentIds })); } catch { /* Storage can be disabled. */ }
  }, [connection, accessDraftKey, state.grantKind, state.allAgents, state.agentIds]);
  useEffect(() => {
    if (host !== "dialog" || !interactionId) return;
    const receive = (event: MessageEvent) => {
      const outcome = readConnectionIntentOAuthOutcome(event, window.location.origin, interactionId);
      if (!outcome) return;
      if (outcome === "connected") {
        // The host verifies durable acceptance; a postMessage is never proof.
        onComplete?.({ resolvedByCallback: true });
      } else {
        setState((s) => ({ ...s, connectStatus: outcome === "declined" ? "cancelled" : "oauth_failed" }));
        onPhaseChange?.("needs_retry");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [host, interactionId, onComplete, onPhaseChange]);
  const edit = (patch: Partial<RemoteMcpSetupState>) => setState((s) => ({ ...s, ...patch }));
  const finish = async (id: string) => {
    try { sessionStorage.removeItem(accessDraftKey); } catch { /* Storage can be disabled. */ }
    await queries.invalidateQueries({ queryKey: ["tools"] });
    if (isAppAggregator(providerId)) {
      // Account inventory is an observation through this human's gateway, not a setup task.
      void resolveAccountUserId(queries).then(userId => {
        const key = queryKeys.tools.aggregatorApps(id, userId);
        return queries.fetchQuery({ queryKey: [...key, "sync"], queryFn: () => toolsApi.syncAggregatorApps(id), staleTime: 0 })
          .then(result => queries.setQueryData(key, result));
      }).catch(() => undefined);
    }
    if (onComplete) onComplete({ connectionId: id });
    else if (providerId === "composio") {
      try { sessionStorage.removeItem(`paperclip:mcp-upstream-app:${selectedCompanyId}:${id}`); } catch { /* Storage may be disabled. */ }
      navigate(`/apps/${id}/permissions`);
    }
    else if (host === "page" && targetApp && targetRoute) {
      try { sessionStorage.removeItem(`paperclip:mcp-upstream-app:${selectedCompanyId}:${id}`); } catch { /* Storage may be disabled. */ }
      navigate("/apps");
    } else if (isAppAggregator(providerId)) navigate("/apps");
    else navigate(`/apps/${id}/permissions`);
  };
  const submit = async (saveDraft = false) => {
    if (busy.current || !selectedCompanyId || !instructionsValid || (connection && !installs.data)) return;
    try {
      const url = new URL(state.url.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch { edit({ connectStatus: "invalid_url" }); return; }
    // Reserve the window while handling the click so popup blockers do not
    // discard the later OAuth response. URL/token-only providers never need it.
    if (!saveDraft && host === "dialog" && state.auth === "auto" && (!popup.current || popup.current.closed)) {
      try {
        popup.current = window.open("about:blank", "paperclip-connection-oauth", "popup,width=720,height=760,resizable=yes,scrollbars=yes");
      } catch { popup.current = null; }
    }
    busy.current = true;
    edit({ connectStatus: "connecting", notice: null });
    try {
      const credentials: Record<string, string> = {};
      if (state.auth === "bearer" && state.token.trim()) credentials["credentials.authorization"] = state.token.trim();
      if (state.auth === "headers" || state.auth === "bearer") {
        for (const header of state.headers) {
          if (!header.name.trim() && !header.value) continue;
          if (!header.name.trim() || !header.value) throw new HeaderInputError();
          credentials[`headers.${header.name.trim()}`] = header.value;
        }
      }
      const managementUrl = providerId === "executor" && state.managementUrl?.trim()
        ? aggregatorManagementUrl("executor", state.managementUrl.trim()) : null;
      if (providerId === "executor" && state.managementUrl?.trim() && !managementUrl) throw new Error(t("oct6Beta.copy162"));
      const prior = savedConnection.current;
      const result = await toolsApi.connectApp(selectedCompanyId, {
        galleryKey: providerId, connectionMethodKey: REMOTE_MCP_CONNECTOR_METHODS[providerId],
        name: provider.name, link: state.url.trim(), grantKind: state.grantKind,
        authMode: state.auth === "headers" ? "custom_headers" : state.auth,
        credentialValues: credentials, saveDraft,
        ...(template && instructions ? { agentInstructions: instructions } : {}),
        ...(prior ? prior.status === "draft" ? { resumeConnectionId: prior.id } : { reconnectConnectionId: prior.id } : {}),
      });
      if (managementUrl) {
        result.connection = await toolsApi.updateConnection(result.connectionId, { config: { ...result.connection.config, managementUrl } });
      }
      savedConnection.current = result.connection;
      if (host === "page" && targetRoute) {
        try { sessionStorage.setItem(`paperclip:mcp-upstream-app:${selectedCompanyId}:${result.connectionId}`, targetRoute.toolkit); } catch { /* Storage may be disabled. */ }
      }
      if (interactionId) {
        try { sessionStorage.setItem(intentDraftKey, result.connectionId); } catch { /* Storage may be disabled. */ }
      }
      // Persist the Access step before leaving for OAuth. Reconnect retains its existing installs.
      if (!requestedAgentId && (!prior || prior.status === "draft")) {
        await toolsApi.putConnectionInstalls(result.connectionId, state.allAgents
          ? [{ targetType: "company", targetId: selectedCompanyId }]
          : state.agentIds.map((targetId) => ({ targetType: "agent", targetId })));
      }
      if (saveDraft) { if (onCancel) onCancel(); else navigate("/apps"); return; }
      if (result.auth?.kind === "oauth") {
        onPhaseChange?.("authorizing");
        const oauth = await toolsApi.startOAuth(result.connectionId, { asCurrentUser: result.connection.credentialPolicy === "per_user", ...(interactionId ? { interactionId } : {}) });
        const target = resolveAuthorizationTarget(oauth.authorizationUrl);
        if (!target.ok) throw new Error(target.message);
        authorizationUrl.current = target.url;
        edit({ connectStatus: "sign_in", token: "", headers: [] });
        try {
          if (host === "dialog") {
            if (!popup.current || popup.current.closed) throw new Error(t("oct6Beta.copy163"));
            popup.current.location.assign(target.url);
            popup.current.focus();
          } else navigateTopLevel(target.url);
        } catch {
          // The connection and OAuth session already exist. Preserve them and
          // let the native sign-in link recover a blocked browser handoff.
          edit({ notice: t("oct6Beta.copy164") });
          onPhaseChange?.("needs_retry");
        }
        return;
      }
      popup.current?.close();
      popup.current = null;
      // The server retains existing permissions when reconnecting. Only a fresh setup enables everything.
      {
        const enabled = new Set(result.catalog.filter((tool) => tool.status === "active").map((tool) => tool.id));
        await toolsApi.finishApp(selectedCompanyId, result.connectionId, {
          enabledCatalogEntryIds: [...enabled],
          // PAP-659 C6a/C7: this path used to send an empty list, so the four
          // gateway connectors were the one place the armed write gate did not
          // apply. The policy now comes from the same helper as the catalog flow.
          askFirstCatalogEntryIds: askFirstCatalogEntryIdsFor(result, (id) => enabled.has(id)),
          access: requestedAgentId ? { agentIds: [requestedAgentId] } : state.allAgents ? "all_agents" : { agentIds: state.agentIds },
          ...(requestedAgentId ? { preserveExistingAccess: true } : {}),
        });
      }
      await finish(result.connectionId);
    } catch (error) {
      popup.current?.close();
      popup.current = null;
      onPhaseChange?.("needs_retry");
      edit({ connectStatus: "idle", notice: error instanceof HeaderInputError ? { key: "sep28Apps.headerBoth" } : error instanceof Error ? error.message : { key: "sep28Apps.connectionFailed" } });
    } finally { busy.current = false; }
  };
  const actions: RemoteMcpSetupActions = {
    edit, navigate: (step) => edit({ step }), connect: () => { void submit(); },
    cancelConnect: () => { if (!busy.current) { popup.current?.close(); popup.current = null; edit({ connectStatus: "cancelled" }); onPhaseChange?.("needs_retry"); } },
    openProvider: (purpose) => {
      if (purpose === "sign_in" && authorizationUrl.current) {
        // The real anchor owns navigation, including in embedded browsers.
        // Do not also redirect the board or open a second scripted window.
        popup.current = null;
        edit({ connectStatus: "sign_in", notice: null });
        onPhaseChange?.("authorizing");
      }
      else window.open(provider.setupUrl, "_blank", "noopener,noreferrer");
    },
    saveExit: () => {
      if (busy.current) return;
      if (state.url.trim()) void submit(true);
      else if (onCancel) onCancel();
      else navigate("/apps");
    },
    resumeDraft: () => edit({ step: "connect" }), finish: () => { if (savedConnection.current) void finish(savedConnection.current.id); },
    refresh: () => {}, reconnect: () => edit({ step: "connect" }), disconnect: () => {},
  };
  if (showChoices && onUseExisting) return <RemoteMcpAccountChoice
    providerName={provider.name} upstreamServiceName={upstreamServiceName}
    connections={existingConnections} pendingId={choicePending} error={chatUiErrorMessage(choiceError)}
    onCancel={onCancel} onConnectNew={() => setShowChoices(false)} onSelect={(id) => {
      setChoicePending(id); setChoiceError(null);
      void onUseExisting(id).catch((error) => { setChoiceError(error instanceof Error ? error.message : { key: "sep28Apps.useConnectionFailed" }); setChoicePending(null); });
    }} />;
  if (connection && !installs.data) return <div className="space-y-3 p-8"><p>{installs.isError ? t("sep28Apps.loadAccessFailed") : t("sep28Apps.loadingAccess")}</p>{installs.isError && <button type="button" className="text-primary underline" onClick={() => void installs.refetch()}>{t("localizationProjectRepositories.retry")}</button>}</div>;
  // Header Cancel abandons unsaved input, including invalid URLs. The separate
  // Save & exit action persists a resumable draft through actions.saveExit.
  return <RemoteMcpConnectionSetup additionalSettings={template && instructions ? <ConnectionInstructionsEditor provider={provider.name} template={template} value={instructions} onChange={setInstructions} disabled={state.connectStatus === "connecting"} /> : undefined} settingsValid={instructionsValid} companyId={selectedCompanyId!} onCancel={onCancel ?? (() => navigate("/apps"))} upstreamServiceName={upstreamServiceName} host={host} lockedAgentId={requestedAgentId} authorizationUrl={authorizationUrl.current} provider={provider} connectionId={savedConnection.current?.id ?? ""} fixedGrantKind={savedConnection.current ? savedConnection.current.credentialPolicy === "per_user" ? "user" : "organization" : undefined} state={state} actions={actions} agents={agents.data ?? []} />;
}
