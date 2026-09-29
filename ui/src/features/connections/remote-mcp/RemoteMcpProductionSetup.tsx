import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { REMOTE_MCP_CONNECTOR_METHODS, type ToolConnection } from "@paperclipai/shared";
import { RemoteMcpAccountChoice } from "./RemoteMcpAccountChoice";
import { readConnectionIntentOAuthOutcome, type ConnectionSetupFlowProps } from "../ConnectionSetupFlow";
import { agentsApi } from "@/api/agents";
import { toolsApi } from "@/api/tools";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useSearchParams } from "@/lib/router";
import { resolveAuthorizationTarget } from "@/lib/authorizationUrl";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { queryKeys } from "@/lib/queryKeys";
import { RemoteMcpConnectionSetup } from "./RemoteMcpConnectionSetup";
import { remoteMcpProviders, type RemoteMcpProviderId } from "./providers";
import type { RemoteMcpSetupActions, RemoteMcpSetupState } from "./types";

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
  const provider = remoteMcpProviders[providerId];
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
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
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const savedConnection = useRef(connection);
  const busy = useRef(false);
  const authorizationUrl = useRef<string | undefined>(undefined);
  const [state, setState] = useState<RemoteMcpSetupState>(() => ({
    step: connection ? "connect" : "access", grantKind: connection ? connection.credentialPolicy === "per_user" ? "user" : "organization" : requestedAgentId ? "user" : "organization",
    setupComplete: Boolean(connection && connection.status !== "draft"),
    url: typeof connection?.config?.url === "string" ? connection.config?.url : provider.defaultUrl,
    auth: connection?.config?.mcpAuthMode === "bearer" ? "bearer" : connection?.authKind === "api_key" ? "headers" : provider.supportsBrowserAuth ? "auto" : "none",
    token: "", headers: [], advanced: false, connectStatus: oauthOutcome === "denied" ? "cancelled" : oauthOutcome === "failed" ? "oauth_failed" : "idle", connected: false,
    identity: null, allAgents: true, agentIds: [], permissions: {}, tools: [], notice: connection?.authKind === "api_key" ? "Saved credentials are retained when these fields are left blank. Enter a replacement only to change them." : null, refreshing: false,
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
    if (onComplete) onComplete({ connectionId: id });
    else navigate(`/apps/${id}/permissions`);
  };
  const submit = async (saveDraft = false) => {
    if (busy.current || !selectedCompanyId || (connection && !installs.data)) return;
    try {
      const url = new URL(state.url.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch { edit({ connectStatus: "invalid_url" }); return; }
    // Reserve the window while handling the click so popup blockers do not
    // discard the later OAuth response. URL/token-only providers never need it.
    if (!saveDraft && host === "dialog" && state.auth === "auto" && (!popup.current || popup.current.closed)) {
      popup.current = window.open("about:blank", "paperclip-connection-oauth", "popup,width=720,height=760,resizable=yes,scrollbars=yes");
    }
    busy.current = true;
    edit({ connectStatus: "connecting", notice: null });
    try {
      const credentials: Record<string, string> = {};
      if (state.auth === "bearer" && state.token.trim()) credentials["credentials.authorization"] = state.token.trim();
      if (state.auth === "headers" || state.auth === "bearer") {
        for (const header of state.headers) {
          if (!header.name.trim() && !header.value) continue;
          if (!header.name.trim() || !header.value) throw new Error("Enter both a name and value for each header.");
          credentials[`headers.${header.name.trim()}`] = header.value;
        }
      }
      const prior = savedConnection.current;
      const result = await toolsApi.connectApp(selectedCompanyId, {
        galleryKey: providerId, connectionMethodKey: REMOTE_MCP_CONNECTOR_METHODS[providerId],
        name: provider.name, link: state.url.trim(), grantKind: state.grantKind,
        authMode: state.auth === "headers" ? "custom_headers" : state.auth,
        credentialValues: credentials, saveDraft,
        ...(prior ? prior.status === "draft" ? { resumeConnectionId: prior.id } : { reconnectConnectionId: prior.id } : {}),
      });
      savedConnection.current = result.connection;
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
        if (host === "dialog") {
          if (popup.current && !popup.current.closed) {
            popup.current.location.assign(target.url);
            popup.current.focus();
          }
        } else navigateTopLevel(target.url);
        return;
      }
      popup.current?.close();
      popup.current = null;
      // The server retains existing permissions when reconnecting. Only a fresh setup enables everything.
      {
        await toolsApi.finishApp(selectedCompanyId, result.connectionId, {
          enabledCatalogEntryIds: result.catalog.filter((tool) => tool.status === "active").map((tool) => tool.id),
          askFirstCatalogEntryIds: [], access: requestedAgentId ? { agentIds: [requestedAgentId] } : state.allAgents ? "all_agents" : { agentIds: state.agentIds },
          ...(requestedAgentId ? { preserveExistingAccess: true } : {}),
        });
      }
      await finish(result.connectionId);
    } catch (error) {
      popup.current?.close();
      popup.current = null;
      onPhaseChange?.("needs_retry");
      edit({ connectStatus: "idle", notice: error instanceof Error ? error.message : "Could not connect. Please try again." });
    } finally { busy.current = false; }
  };
  const actions: RemoteMcpSetupActions = {
    edit, navigate: (step) => edit({ step }), connect: () => { void submit(); },
    cancelConnect: () => { if (!busy.current) { popup.current?.close(); popup.current = null; edit({ connectStatus: "cancelled" }); onPhaseChange?.("needs_retry"); } },
    openProvider: (purpose) => {
      if (purpose === "sign_in" && authorizationUrl.current) { if (host === "dialog") { popup.current = null; edit({ connectStatus: "sign_in" }); } else navigateTopLevel(authorizationUrl.current); }
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
    connections={existingConnections} pendingId={choicePending} error={choiceError}
    onCancel={onCancel} onConnectNew={() => setShowChoices(false)} onSelect={(id) => {
      setChoicePending(id); setChoiceError(null);
      void onUseExisting(id).catch((error) => { setChoiceError(error instanceof Error ? error.message : "Could not use this connection."); setChoicePending(null); });
    }} />;
  if (connection && !installs.data) return <div className="space-y-3 p-8"><p>{installs.isError ? "Could not load saved access. Retry before changing this connection." : "Loading saved access…"}</p>{installs.isError && <button type="button" className="text-primary underline" onClick={() => void installs.refetch()}>Try again</button>}</div>;
  return <RemoteMcpConnectionSetup upstreamServiceName={upstreamServiceName} host={host} lockedAgentId={requestedAgentId} authorizationUrl={host === "dialog" ? authorizationUrl.current : undefined} provider={provider} connectionId={savedConnection.current?.id ?? ""} fixedGrantKind={savedConnection.current ? savedConnection.current.credentialPolicy === "per_user" ? "user" : "organization" : undefined} state={state} actions={actions} agents={agents.data ?? []} />;
}
