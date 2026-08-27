import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ClipboardPaste,
  Link2,
  Loader2,
  Lock,
  Search,
  ShieldCheck,
  TerminalSquare,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  Agent,
  AppDefinition,
  ConnectionGrantKind,
  ConnectionMethodDef,
  ConnectToolAppResult,
  FieldDef,
  ToolApplication,
  ToolConnection,
  ToolConnectionAuthKind,
  ToolConnectionCredentialSource,
  ToolConnectionCreateCapabilities,
} from "@paperclipai/shared";
import {
  connectionMethodAcceptsCustomerOAuthClient,
  connectionMethodRequiresConfiguration,
  connectionMethodSupportsAutomaticOAuth,
  credentialConfigPath,
  getAppDefinitionForUrl,
  getConnectableAppDefinition,
  getAvailableConnectionMethod,
  getAvailableConnectionMethods,
  getRecommendedConnectionMethod,
} from "@paperclipai/shared";
import { useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { ApiError } from "@/api/client";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { appCopyFor, credentialFieldLabel } from "@/lib/app-gallery-copy";
import { advancedTabHref } from "@/pages/tools/tool-tabs";
import { AgentIcon } from "@/components/AgentIconPicker";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { resolveAuthorizationTarget } from "@/lib/authorizationUrl";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";
import { AppLogo } from "@/pages/apps/AppLogo";
import { appApplicationSourceSlug } from "@/pages/apps/app-definition-display";
import { UnverifiedServerBadge } from "@/pages/apps/UnverifiedServerBadge";
import {
  appSourceConnectHref,
  isMcpDirectOAuthConnectSlug,
  resolveAppsConnectRouteKey,
  vercelConnectSourceHref,
} from "@/pages/apps/app-connect-policy";
import { parseGoogleSheetIds } from "@/pages/apps/google-sheets";
import { connectionNameForGrantKind } from "@/pages/apps/connection-identity";
import {
  canSubmitGenericConnect,
  customHeaderError,
  defaultGenericMcpName,
  endpointHost,
  genericConnectGuidance,
  genericConnectPayload,
  newCustomHeaderRow,
  oauthCallbackUrlForBrowser,
  type CustomHeaderRow,
  type GenericConnectDraft,
  type GenericConnectGuidance,
  type GenericMcpAuthMode,
} from "@/pages/apps/generic-mcp-connect";
import { autoExtendNotice, INSTALL_ALL_WARNING, installInfoNotice, installPayload } from "@/lib/tool-installs";

type Step = "gallery" | "access" | "key" | "success";
export type OAuthConnectPhase = "entry" | "starting" | "redirecting" | "error";

const ROUTE_STAGE_BY_STEP: Partial<Record<Step, string>> = {
  access: "access",
  key: "setup",
  success: "complete",
};

export function requestedConnectionEntry(input: {
  requestedAppKey: string;
  galleryApps: readonly AppDefinition[];
  reconnectConnection: ToolConnection | null;
  applications: readonly ToolApplication[];
}): AppDefinition | null {
  const visible = input.galleryApps.find((candidate) => candidate.slug === input.requestedAppKey);
  if (visible) return visible;
  if (!input.reconnectConnection) return null;
  const application = input.applications.find(
    (candidate) => candidate.id === input.reconnectConnection?.applicationId,
  );
  if (appApplicationSourceSlug(application) !== input.requestedAppKey) return null;
  return getConnectableAppDefinition(input.requestedAppKey);
}

export function isVercelConnectUnavailable(input: {
  credentialSource: ToolConnectionCredentialSource;
  available: boolean;
  retainedReconnectMatches: boolean;
}): boolean {
  return input.credentialSource === "vercel_connect"
    && !input.available
    && !input.retainedReconnectMatches;
}

function appConnectHref(
  appKey: string,
  step: Step,
  credentialSource: ToolConnectionCredentialSource,
  existing?: { resumeConnectionId?: string | null; reconnectConnectionId?: string | null },
): string {
  const stage = ROUTE_STAGE_BY_STEP[step] ?? "setup";
  const params = new URLSearchParams({ source: appKey, stage });
  if (existing?.resumeConnectionId) params.set("resume", existing.resumeConnectionId);
  if (existing?.reconnectConnectionId) params.set("reconnect", existing.reconnectConnectionId);
  const path = credentialSource === "vercel_connect" ? "/apps/vercel-connect" : "/apps/connect";
  return `${path}?${params.toString()}`;
}
type AppAccessSelection = "all_agents" | { agentIds: string[] };

// Access comes before credentials so the reader knows what identity and reach
// the secret is about to get before they share it (PAP-17835).
const STEP_LABELS = ["Pick app", "Access", "Add your key"];
const STEP_INDEX: Record<Exclude<Step, "success">, number> = {
  gallery: 0,
  access: 1,
  key: 2,
};
const ZAPIER_STEP_INDEX: Record<Exclude<Step, "gallery" | "success">, number> = {
  key: 0,
  access: 1,
};
const ZAPIER_STEP_LABELS = ["Add MCP URL"];

/**
 * Which identity a fresh connection should default to (PAP-17835).
 *
 * Company identity is the product default whenever the selected method permits
 * it. Personal-only methods still stay personal, and reconnects preserve their
 * original identity through the explicit reconnect hint.
 */
function defaultGrantKindFor(method: ConnectionMethodDef | null): ConnectionGrantKind {
  if (method?.grantKinds?.length === 1) return method.grantKinds[0]!;
  return "organization";
}

function isGoogleSheetsRobotMethod(
  entry: AppDefinition | null,
  method: ConnectionMethodDef | string | null | undefined,
): boolean {
  const methodKey = typeof method === "string" ? method : method?.key;
  return entry?.slug === "google-sheets" && methodKey === "local";
}

function defaultMethodConfig(method: ConnectionMethodDef | null): Record<string, string | boolean> {
  if (!method) return {};
  return Object.fromEntries(
    [...(method.tenantFields ?? []), ...(method.extensionFields ?? [])]
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, field.defaultValue!]),
  );
}

function connectionMethodsForCredentialSource(
  entry: AppDefinition | null | undefined,
  credentialSource: ToolConnectionCredentialSource,
): ConnectionMethodDef[] {
  if (!entry) return [];
  const methods = getAvailableConnectionMethods(entry);
  return credentialSource === "vercel_connect"
    ? methods.filter((method) => Boolean(method.credentialSources?.vercelConnect))
    : methods;
}

function recommendedSetupConnectionMethod(
  methods: readonly ConnectionMethodDef[],
): ConnectionMethodDef | null {
  const recommended = getRecommendedConnectionMethod(methods);
  // Capability choices (for example Google Workspace read versus write) have
  // an intentional default. Unrelated region/authentication variants should
  // still ask the operator to choose unless only one is available.
  return methods.length === 1 || recommended?.capabilityProfile
    ? recommended
    : null;
}

function canUseAutomaticOAuthFastPath(entry: AppDefinition | null | undefined): boolean {
  if (!entry) return false;
  const methods = getAvailableConnectionMethods(entry);
  const method = methods.length === 1 ? methods[0] : null;
  return Boolean(
    method
    && connectionMethodSupportsAutomaticOAuth(method)
    && !connectionMethodRequiresConfiguration(method),
  );
}

function automaticOAuthMethod(entry: AppDefinition | null | undefined): ConnectionMethodDef | null {
  if (!entry) return null;
  const methods = getAvailableConnectionMethods(entry);
  const method = methods.length === 1 ? methods[0] : null;
  return method && connectionMethodSupportsAutomaticOAuth(method) ? method : null;
}

function appSourceSlug(application: ToolApplication): string | null {
  const metadata = application.metadata;
  if (!metadata) return null;
  const source = metadata.sourceTemplateKey ?? metadata.galleryKey;
  return typeof source === "string" ? source : null;
}

function connectionSourceSlug(connection: ToolConnection): string | null {
  const source = connection.config?.sourceTemplateKey ?? connection.transportConfig.sourceTemplateKey;
  return typeof source === "string" ? source : null;
}

function reusableOAuthConnection(
  sourceSlug: string | null,
  applications: ToolApplication[],
  connections: ToolConnection[],
  options: { applicationId?: string; draftOnly?: boolean } = {},
): ToolConnection | null {
  if (!sourceSlug) return null;
  const matchingApplicationIds = new Set(
    applications
      .filter((application) =>
        application.status !== "archived" &&
        appSourceSlug(application) === sourceSlug &&
        (!options.applicationId || application.id === options.applicationId)
      )
      .map((application) => application.id),
  );
  return connections.find((connection) => {
    const matchesApplication = options.applicationId
      ? connection.applicationId === options.applicationId
      : matchingApplicationIds.has(connection.applicationId) || connectionSourceSlug(connection) === sourceSlug;
    return connection.status !== "archived" &&
      (!options.draftOnly || connection.status === "draft") &&
      connection.authKind === "oauth" &&
      matchesApplication;
  }) ?? null;
}

export type ConnectionSetupCompletion =
  | { connectionId: string; resolvedByCallback?: false }
  /** OAuth callbacks finalize server-side before notifying their opener. */
  | { resolvedByCallback: true };

export type ConnectionIntentOAuthOutcome = "connected" | "declined" | "failed";

export function readConnectionIntentOAuthOutcome(
  event: Pick<MessageEvent, "origin" | "data">,
  expectedOrigin: string,
  interactionId: string,
): ConnectionIntentOAuthOutcome | null {
  if (event.origin !== expectedOrigin || !event.data || typeof event.data !== "object") return null;
  const message = event.data as {
    type?: unknown;
    interactionId?: unknown;
    outcome?: unknown;
  };
  if (
    message.type !== "paperclip.connection-intent.oauth"
    || message.interactionId !== interactionId
  ) return null;
  return message.outcome === "connected"
    || message.outcome === "declined"
    || message.outcome === "failed"
    ? message.outcome
    : null;
}

export interface ConnectionSetupFlowProps {
  byoOnly?: boolean;
  credentialSource?: ToolConnectionCredentialSource;
  host?: "page" | "dialog";
  serviceSlug?: string;
  requestedAgentId?: string;
  interactionId?: string;
  existingConnections?: ToolConnection[];
  onUseExisting?: (connectionId: string) => Promise<void>;
  onComplete?: (result: ConnectionSetupCompletion) => void;
  onOAuthDeclined?: () => void;
  onPhaseChange?: (phase: "requested" | "authorizing" | "needs_retry") => void;
  onCancel?: () => void;
}

/**
 * The single connection setup implementation used by both the Apps store and
 * task-hosted connection intents. Hosts supply presentation and completion
 * callbacks; provider fields, validation, OAuth, access, and finishing remain
 * here so a provider can never drift between entry points.
 */
export function ConnectionSetupFlow({
  byoOnly = false,
  credentialSource = "paperclip_vault",
  host = "page",
  serviceSlug,
  requestedAgentId,
  interactionId,
  existingConnections = [],
  onUseExisting,
  onComplete,
  onOAuthDeclined,
  onPhaseChange,
  onCancel,
}: ConnectionSetupFlowProps = {}) {
  const routeNavigate = useNavigate();
  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (host !== "page") return;
    if (options) routeNavigate(to, options);
    else routeNavigate(to);
  }, [host, routeNavigate]);
  const routeParams = useParams<{ appKey?: string }>();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [searchParams] = useSearchParams();
  const appKey = routeParams.appKey ?? searchParams.get("appKey") ?? undefined;
  const sourceSlug = searchParams.get("source")?.trim() || null;
  const createNewConnection = searchParams.get("new") === "1";
  const resumeConnectionId = searchParams.get("resume")?.trim() || null;
  const oauthCallbackOutcome = searchParams.get("oauth");
  const reconnectConnectionId = searchParams.get("reconnect")?.trim() || null;
  const reconnectGrantKindHint: ConnectionGrantKind | null = searchParams.get("identity") === "user"
    ? "user"
    : searchParams.get("identity") === "organization"
      ? "organization"
      : null;
  const vercelConnectMode = credentialSource === "vercel_connect";
  const directOAuthCandidate = serviceSlug ?? sourceSlug;
  const directOAuthSource = credentialSource === "paperclip_vault"
    && isMcpDirectOAuthConnectSlug(directOAuthCandidate)
    ? directOAuthCandidate
    : null;
  // `source` is the generic curated-app route contract, not an OAuth-only
  // shortcut. Manual OAuth, API-key, no-auth, and configured MCP definitions
  // must all enter the same branded setup flow when Browse links to them.
  const routeAppKey = resolveAppsConnectRouteKey({ serviceSlug, appKey, sourceSlug });
  const zapierSource = (serviceSlug ?? sourceSlug ?? appKey) === "zapier";
  const requestedAppKey = zapierSource ? undefined : routeAppKey;
  const byo = host === "page" && (byoOnly || searchParams.get("byo") === "1");

  // Prefill arrives from the app page for reconnects; read once so later
  // wizard navigation doesn't fight the URL.
  const [prefill] = useState(() => {
    const rawLink = searchParams.get("link")?.trim() ?? "";
    return {
      link: /^https?:\/\//i.test(rawLink) ? rawLink : "",
      name: searchParams.get("name")?.trim() ?? "",
      applicationId: searchParams.get("applicationId")?.trim() || undefined,
    };
  });

  const [step, setStep] = useState<Step>(requestedAppKey || prefill.link || zapierSource ? "key" : "gallery");
  const [entry, setEntry] = useState<AppDefinition | null>(null);
  const [galleryName, setGalleryName] = useState("");
  const [linkUrl, setLinkUrl] = useState(prefill.link);
  const [linkName, setLinkName] = useState(prefill.name || (zapierSource ? "Zapier" : ""));
  const [linkNeedsKey, setLinkNeedsKey] = useState(false);
  const [linkKey, setLinkKey] = useState("");
  // Generic ("connect your own MCP server") flow state. `authMode: auto` is the
  // simple path: Paperclip probes the endpoint and branches on what it finds.
  const [linkAuthMode, setLinkAuthMode] = useState<GenericMcpAuthMode>("auto");
  const [linkHeaders, setLinkHeaders] = useState<CustomHeaderRow[]>(() => [newCustomHeaderRow()]);
  const [linkOAuthClientId, setLinkOAuthClientId] = useState("");
  const [linkOAuthClientSecret, setLinkOAuthClientSecret] = useState("");
  const [linkAdvancedOpen, setLinkAdvancedOpen] = useState(false);
  const [linkGuidance, setLinkGuidance] = useState<GenericConnectGuidance | null>(null);
  const [genericOAuthPending, setGenericOAuthPending] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [curatedOAuthClientId, setCuratedOAuthClientId] = useState("");
  const [curatedOAuthClientSecret, setCuratedOAuthClientSecret] = useState("");
  const [vercelConnector, setVercelConnector] = useState("");
  const [connectionMethodKey, setConnectionMethodKey] = useState("");
  const [configValues, setConfigValues] = useState<Record<string, string | boolean>>({});
  const [googleSheetsLinks, setGoogleSheetsLinks] = useState("");
  const [googleSheetsError, setGoogleSheetsError] = useState<string | null>(null);
  const [connectResult, setConnectResult] = useState<ConnectToolAppResult | null>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [access, setAccess] = useState<"all" | "specific">("all");
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [installAgentIds, setInstallAgentIds] = useState<Set<string>>(
    () => new Set(requestedAgentId ? [requestedAgentId] : []),
  );
  /**
   * Access-step selections (PAP-17835). These are chosen before the credential
   * and committed with it, so they must survive a failed submit and a trip
   * backwards through the wizard.
   */
  const [grantKind, setGrantKind] = useState<ConnectionGrantKind>(
    reconnectGrantKindHint ?? "organization",
  );
  const [installChoice, setInstallChoice] = useState<"specific" | "all">(
    requestedAgentId ? "specific" : "all",
  );
  const resumingAfterOAuthFailure = Boolean(
    resumeConnectionId
    && (oauthCallbackOutcome === "failed" || oauthCallbackOutcome === "denied"),
  );
  const [oauthPhase, setOAuthPhase] = useState<OAuthConnectPhase>(
    resumingAfterOAuthFailure ? "error" : "entry",
  );
  const [oauthError, setOAuthError] = useState<string | null>(() => {
    if (!resumingAfterOAuthFailure) return null;
    return oauthCallbackOutcome === "denied"
      ? "Authorization was cancelled or declined. Your saved connection was not changed."
      : "Authorization did not complete. Your saved connection is still here, so you can try again.";
  });
  /** Host of the page the operator is about to be sent to, shown while redirecting. */
  const [authorizationHost, setAuthorizationHost] = useState<string | null>(null);
  const directOAuthAccessConfirmedRef = useRef(false);
  const directOAuthRetryingRef = useRef(false);
  const hydratedResumeConnectionIdRef = useRef<string | null>(null);
  const [hydratedResumeConnectionId, setHydratedResumeConnectionId] = useState<string | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);
  const [showConnectionChoice, setShowConnectionChoice] = useState(
    existingConnections.length > 0 && Boolean(onUseExisting),
  );
  const [existingConnectionPendingId, setExistingConnectionPendingId] = useState<string | null>(null);
  const [existingConnectionError, setExistingConnectionError] = useState<string | null>(null);

  const reserveOAuthPopup = useCallback(() => {
    if (host !== "dialog" || oauthPopupRef.current?.closed === false) return;
    oauthPopupRef.current = window.open(
      "about:blank",
      "paperclip-connection-oauth",
      "popup,width=720,height=760,resizable=yes,scrollbars=yes",
    );
  }, [host]);

  const openAuthorization = useCallback((url: string) => {
    if (host !== "dialog") {
      navigateTopLevel(url);
      return;
    }
    const popup = oauthPopupRef.current;
    if (!popup || popup.closed) {
      setOAuthPhase("error");
      setOAuthError("Paperclip couldn’t open the sign-in window. Allow popups for this site and try again.");
      onPhaseChange?.("needs_retry");
      return;
    }
    popup.location.assign(url);
    popup.focus();
  }, [host, onPhaseChange]);

  useEffect(() => {
    if (host !== "dialog" || !interactionId) return;
    const receiveOAuthOutcome = (event: MessageEvent) => {
      const outcome = readConnectionIntentOAuthOutcome(event, window.location.origin, interactionId);
      if (outcome === "connected") {
        onComplete?.({ resolvedByCallback: true });
        return;
      }
      if (outcome === "declined") {
        onOAuthDeclined?.();
        return;
      }
      if (outcome !== "failed") return;
      setOAuthPhase("error");
      setOAuthError("Authorization did not complete. Try again when you’re ready.");
    };
    window.addEventListener("message", receiveOAuthOutcome);
    return () => window.removeEventListener("message", receiveOAuthOutcome);
  }, [host, interactionId, onComplete, onOAuthDeclined]);

  const resetGenericAuthState = () => {
    setLinkAuthMode("auto");
    setLinkHeaders([newCustomHeaderRow()]);
    setLinkOAuthClientId("");
    setLinkOAuthClientSecret("");
    setLinkAdvancedOpen(false);
    setLinkGuidance(null);
    setGenericOAuthPending(false);
  };

  /**
   * Switch to a curated app's branded setup. Reached from the gallery grid and, as
   * a convenience, from the guided generic flow when the pasted endpoint matches a
   * definition — the generic path stays available either way.
   */
  const useMatchedGalleryEntry = (picked: AppDefinition) => {
    if (picked.slug === "zapier") {
      setEntry(null);
      setGalleryName("");
      setLinkUrl("");
      setLinkName("Zapier");
      setLinkNeedsKey(false);
      setLinkKey("");
      resetGenericAuthState();
      setCredentials({});
      setConnectResult(null);
      setStep("key");
      navigate("/apps/connect?byo=1&source=zapier");
      return;
    }
    if (credentialSource === "paperclip_vault" && canUseAutomaticOAuthFastPath(picked)) {
      navigate(appSourceConnectHref(picked.slug));
      return;
    }
    setEntry(picked);
    setGalleryName(picked.name);
    setLinkUrl("");
    setLinkName("");
    setLinkNeedsKey(false);
    setLinkKey("");
    resetGenericAuthState();
    setCredentials({});
    setCuratedOAuthClientId("");
    setCuratedOAuthClientSecret("");
    setVercelConnector("");
    const methods = connectionMethodsForCredentialSource(picked, credentialSource);
    const initialMethod = recommendedSetupConnectionMethod(methods);
    setConnectionMethodKey(initialMethod?.key ?? "");
    setConfigValues(defaultMethodConfig(initialMethod));
    setGoogleSheetsLinks("");
    setGoogleSheetsError(null);
    setConnectResult(null);
    setInstallAgentIds(new Set(requestedAgentId ? [requestedAgentId] : []));
    setInstallChoice(requestedAgentId ? "specific" : "all");
    setGrantKind(reconnectGrantKind ?? defaultGrantKindFor(initialMethod));
    setStep("access");
    navigate(
      credentialSource === "vercel_connect"
        ? vercelConnectSourceHref(picked.slug)
        : appSourceConnectHref(picked.slug),
    );
  };

  const openGallery = () => {
    setEntry(null);
    setGalleryName("");
    setLinkUrl("");
    setLinkName("");
    setLinkNeedsKey(false);
    setLinkKey("");
    resetGenericAuthState();
    setCredentials({});
    setCuratedOAuthClientId("");
    setCuratedOAuthClientSecret("");
    setVercelConnector("");
    setConnectionMethodKey("");
    setConfigValues({});
    setGoogleSheetsLinks("");
    setGoogleSheetsError(null);
    setConnectResult(null);
    setInstallAgentIds(new Set(requestedAgentId ? [requestedAgentId] : []));
    setInstallChoice(requestedAgentId ? "specific" : "all");
    setGrantKind("organization");
    setStep("gallery");
    navigate(
      credentialSource === "vercel_connect"
        ? vercelConnectSourceHref()
        : byoOnly ? "/apps/byo" : "/apps/connect?byo=1",
    );
  };

  useEffect(() => {
    if (host !== "page") return;
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: vercelConnectMode ? "Vercel Connect" : byoOnly ? "Connect your own tool" : "Connect an app" },
    ]);
    return () => setBreadcrumbs([]);
  }, [byoOnly, host, setBreadcrumbs, selectedCompany?.name, vercelConnectMode]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId && (!!directOAuthSource || !!resumeConnectionId || !!reconnectConnectionId),
    refetchOnMount: "always",
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId && (!!directOAuthSource || !!resumeConnectionId || !!reconnectConnectionId),
    refetchOnMount: "always",
  });
  const existingOAuthConnection = useMemo(
    () => reusableOAuthConnection(
      directOAuthSource,
      applicationsQuery.data?.applications ?? [],
      connectionsQuery.data?.connections ?? [],
      createNewConnection
        ? { applicationId: prefill.applicationId, draftOnly: true }
        : {},
    ),
    [applicationsQuery.data, connectionsQuery.data, createNewConnection, directOAuthSource, prefill.applicationId],
  );
  const reconnectConnection = useMemo(
    () => reconnectConnectionId
      ? (connectionsQuery.data?.connections ?? []).find((connection) => connection.id === reconnectConnectionId) ?? null
      : null,
    [connectionsQuery.data, reconnectConnectionId],
  );
  const reconnectApplication = useMemo(
    () => reconnectConnection
      ? (applicationsQuery.data?.applications ?? []).find(
        (application) => application.id === reconnectConnection.applicationId,
      ) ?? null
      : null,
    [applicationsQuery.data, reconnectConnection],
  );
  const reconnectSourceMatches = Boolean(
    reconnectConnection
    && reconnectApplication
    && requestedAppKey
    && appApplicationSourceSlug(reconnectApplication) === requestedAppKey,
  );
  const resumeConnection = useMemo(
    () => resumeConnectionId
      ? (connectionsQuery.data?.connections ?? []).find((connection) => connection.id === resumeConnectionId) ?? null
      : null,
    [connectionsQuery.data, resumeConnectionId],
  );
  const identityConnection = resumeConnection ?? reconnectConnection;
  const reconnectGrantKind: ConnectionGrantKind | null = identityConnection
    ? identityConnection.credentialPolicy === "per_user"
      ? "user"
      : "organization"
    : reconnectGrantKindHint;
  const resumableOAuthConnection = resumeConnection?.authKind === "oauth"
    ? resumeConnection
    : existingOAuthConnection;
  const existingOAuthGrantKind: ConnectionGrantKind | null = existingOAuthConnection
    ? existingOAuthConnection.credentialPolicy === "per_user"
      ? "user"
      : "organization"
    : null;
  const fixedGrantKind = reconnectGrantKind ?? existingOAuthGrantKind;

  useEffect(() => {
    if (fixedGrantKind) setGrantKind(fixedGrantKind);
  }, [fixedGrantKind]);

  // A curated definition covering the pasted endpoint is offered as a branded
  // convenience only; the generic flow remains the default and stays complete.
  const linkMatchedEntry = useMemo(
    () => (linkUrl && !entry ? getAppDefinitionForUrl(linkUrl, galleryQuery.data?.apps ?? []) : null),
    [entry, galleryQuery.data, linkUrl],
  );

  const entryAutomaticOAuthMethod = automaticOAuthMethod(entry);
  const automaticOAuthEntry = credentialSource === "paperclip_vault" && entryAutomaticOAuthMethod ? entry : null;
  const directOAuthEntry = credentialSource === "paperclip_vault" && canUseAutomaticOAuthFastPath(entry) ? entry : null;
  const directOAuthLookupPending = Boolean(directOAuthSource) && (
    !applicationsQuery.isFetchedAfterMount || !connectionsQuery.isFetchedAfterMount
  );

  const setAppStep = (nextStep: Step) => {
    setStep(nextStep);
    if (entry) {
      navigate(appConnectHref(entry.slug, nextStep, credentialSource, {
        resumeConnectionId,
        reconnectConnectionId,
      }));
    }
  };

  const oauthStartMutation = useMutation({
    // Retry/reconnect reads identity from the durable connection. Provider is
    // not identity: an organization Notion connection must stay organization-
    // scoped, while a personal one must put its token back on that user grant.
    mutationFn: (connection: ToolConnection) => toolsApi.startOAuth(connection.id, {
      asCurrentUser: connection.credentialPolicy === "per_user",
      ...(interactionId ? { interactionId } : {}),
    }),
    onSuccess: ({ authorizationUrl }) => {
      // The endpoint chose this address, so it is checked here too — this is the
      // line where an unsafe scheme would actually run (PAP-17099).
      const target = resolveAuthorizationTarget(authorizationUrl);
      if (!target.ok) {
        setOAuthPhase("error");
        setOAuthError(target.message);
        onPhaseChange?.("needs_retry");
        return;
      }
      setAuthorizationHost(target.host);
      setOAuthPhase("redirecting");
      openAuthorization(target.url);
    },
    onError: (error) => {
      const details = error instanceof ApiError && error.body && typeof error.body === "object"
        ? (error.body as { details?: { code?: unknown } }).details
        : null;
      setOAuthPhase("error");
      onPhaseChange?.("needs_retry");
      setOAuthError(
        details?.code === "invalid_grant"
          ? "Your authorization expired or was revoked. Reconnect to continue."
          : error instanceof Error
            ? error.message
            : "Paperclip couldn’t start secure sign-in. Try again.",
      );
    },
  });
  const mutateOAuthStart = oauthStartMutation.mutate;
  const startOAuth = useCallback((connection: ToolConnection) => {
    onPhaseChange?.("authorizing");
    reserveOAuthPopup();
    mutateOAuthStart(connection);
  }, [mutateOAuthStart, onPhaseChange, reserveOAuthPopup]);

  /**
   * Commit the Access step's agent reach for a connection. Shared by the
   * key-path finish and the OAuth redirect, so both routes through the wizard
   * apply the same selection.
   */
  const applyAccessInstalls = async (connectionId: string) => {
    const installState = installChoice === "all"
      ? { onAll: true, agentIds: new Set<string>() }
      : { onAll: false, agentIds: installAgentIds };
    await toolsApi.putConnectionInstalls(connectionId, installPayload(selectedCompanyId!, installState));
  };

  const effectiveGrantKind = fixedGrantKind ?? grantKind;
  const connectMutation = useMutation({
    mutationFn: async (entryOverride?: AppDefinition) => {
      const connectEntry = entryOverride ?? entry;
      let result: ConnectToolAppResult;
      if (connectEntry) {
        const requestedGrantKind = fixedGrantKind ?? grantKind;
        const selectedMethod = getAvailableConnectionMethod(connectEntry, connectionMethodKey || null);
        const sheetIds = isGoogleSheetsRobotMethod(connectEntry, selectedMethod)
          ? parseGoogleSheetIds(googleSheetsLinks).ids
          : [];
        const trimmedGalleryName = galleryName.trim();
        const connectionName = connectionNameForGrantKind(
          trimmedGalleryName || connectEntry.name,
          requestedGrantKind,
        );
        result = await toolsApi.connectApp(selectedCompanyId!, {
          galleryKey: connectEntry.slug,
          ...(connectionMethodKey ? { connectionMethodKey } : {}),
          name: connectionName,
          credentialSource,
          ...(credentialSource === "paperclip_vault" ? { credentialValues: credentials } : {}),
          ...(credentialSource === "vercel_connect"
            ? { vercelConnect: { connector: vercelConnector.trim() } }
            : {}),
          ...(curatedOAuthClientId.trim()
            ? {
                oauthClient: {
                  clientId: curatedOAuthClientId.trim(),
                  ...(curatedOAuthClientSecret ? { clientSecret: curatedOAuthClientSecret } : {}),
                },
              }
            : {}),
          configValues: isGoogleSheetsRobotMethod(connectEntry, selectedMethod)
            ? { allowedSpreadsheetIds: sheetIds }
            : Object.keys(configValues).length > 0
              ? configValues
              : undefined,
          applicationId: prefill.applicationId,
          ...(resumeConnectionId ? { resumeConnectionId } : {}),
          ...(requestedGrantKind === "user" ? { grantKind: requestedGrantKind } : {}),
        });
      } else {
        const genericPayload = genericConnectPayload({
          link: linkUrl,
          name: linkName,
          authMode: linkAuthMode,
          needsKey: linkNeedsKey,
          keyValue: linkKey,
          headers: linkHeaders,
          oauthClientId: linkOAuthClientId,
          oauthClientSecret: linkOAuthClientSecret,
        });
        const connectionName = connectionNameForGrantKind(
          genericPayload.name ?? defaultGenericMcpName(linkUrl) ?? "Custom app",
          effectiveGrantKind,
        );
        result = await toolsApi.connectApp(selectedCompanyId!, {
          ...genericPayload,
          // Zapier issues a credential-bearing URL, so its branded setup keeps
          // the compact pasted-URL step. It is still a curated app, though: the
          // gallery identity must reach the server or Browse can only see a
          // generic `link` application after setup succeeds.
          ...(zapierSource || linkMatchedEntry?.slug === "zapier"
            ? {
                galleryKey: "zapier",
                connectionMethodKey: "generated-url",
              }
            : {}),
          name: connectionName,
          applicationId: prefill.applicationId,
          ...(effectiveGrantKind === "user" ? { grantKind: effectiveGrantKind } : {}),
        });
      }
      // A resumable draft already owns its identity and install reach. Replacing
      // those choices with this page's defaults would turn "finish setup" into a
      // silent access change. Fresh connections still persist the Access step
      // before the browser leaves Paperclip.
      if (result.auth?.kind === "oauth" && !resumeConnectionId && !reconnectConnectionId) {
        await applyAccessInstalls(result.connectionId);
      }
      return result;
    },
    onSuccess: (result) => {
      if (result.auth?.kind === "oauth") {
        setConnectResult(result);
        // The mutation saves the Access selection before this callback opens
        // the provider, so the authorization handoff cannot outrun agent reach.
        // Discovery worked but this authorization server insists on a client the
        // operator registers themselves. Keep the draft and ask for it in place
        // rather than sending them back to the start.
        if (result.auth.manualClientRequired) {
          setLinkGuidance(genericConnectGuidance("oauth_manual_client_required", null));
          setLinkAuthMode("oauth");
          setLinkAdvancedOpen(true);
          setGenericOAuthPending(false);
          return;
        }
        if (host === "dialog") {
          setOAuthPhase("starting");
          setGenericOAuthPending(!entry);
          startOAuth(result.connection);
          return;
        }
        const startUrl = result.auth.startUrl?.trim();
        if (!startUrl) {
          setOAuthPhase("starting");
          setGenericOAuthPending(true);
          startOAuth(result.connection);
          return;
        }
        const target = resolveAuthorizationTarget(startUrl);
        if (!target.ok) {
          setGenericOAuthPending(true);
          setOAuthPhase("error");
          setOAuthError(target.message);
          onPhaseChange?.("needs_retry");
          return;
        }
        setAuthorizationHost(target.host);
        setOAuthPhase("redirecting");
        setGenericOAuthPending(true);
        openAuthorization(target.url);
        return;
      }
      setLinkGuidance(null);
      setConnectResult(result);
      const defaults: Record<string, boolean> = {};
      for (const a of result.actions.readOnly) defaults[a.catalogEntryId] = true;
      for (const a of result.actions.canMakeChanges) defaults[a.catalogEntryId] = true;
      setEnabled(defaults);
      finishMutation.mutate({ result, enabled: defaults });
    },
    onError: (error) => {
      const details = error instanceof ApiError && error.body && typeof error.body === "object"
        ? (error.body as { details?: { code?: unknown } }).details
        : null;
      if (automaticOAuthEntry) {
        setOAuthPhase("error");
        onPhaseChange?.("needs_retry");
        setOAuthError(
          details?.code === "invalid_grant"
            ? "Your authorization expired or was revoked. Reconnect to continue."
            : error instanceof Error
              ? error.message
              : "Paperclip couldn’t start secure sign-in. Try again.",
        );
        return;
      }
      // The generic URL path explains the specific corrective action inline,
      // beside the fields the operator has to change. A toast can't do that, and
      // for a pasted address "check your key" is usually the wrong advice.
      if (!entry && linkUrl) {
        const code = typeof details?.code === "string" ? details.code : null;
        const guidance = genericConnectGuidance(code, error instanceof Error ? error.message : null);
        setLinkGuidance(guidance);
        setGenericOAuthPending(false);
        if (guidance.focus === "credentials") setLinkAdvancedOpen(true);
        return;
      }
      pushToast({
        title: "Couldn’t connect",
        body: error instanceof Error ? error.message : "Please check your key and try again.",
        tone: "error",
      });
    },
  });
  const mutateConnect = connectMutation.mutate;
  const connectApp = useCallback((entryOverride?: AppDefinition) => {
    const connectEntry = entryOverride ?? entry;
    const method = connectEntry
      ? getAvailableConnectionMethod(connectEntry, connectionMethodKey || null)
      : null;
    if (method?.auth === "oauth") {
      reserveOAuthPopup();
    }
    mutateConnect(entryOverride);
  }, [connectionMethodKey, entry, mutateConnect, reserveOAuthPopup]);

  useEffect(() => {
    if (!requestedAppKey || galleryQuery.isLoading || !galleryQuery.data) return;

    if (reconnectConnectionId && (
      !connectionsQuery.isFetchedAfterMount
      || !applicationsQuery.isFetchedAfterMount
    )) return;

    const requestedEntry = requestedConnectionEntry({
      requestedAppKey,
      galleryApps: galleryQuery.data.apps,
      reconnectConnection,
      applications: applicationsQuery.data?.applications ?? [],
    });
    const methods = connectionMethodsForCredentialSource(requestedEntry, credentialSource);
    const method = methods.length === 1 ? methods[0]! : null;
    const automaticOAuth = credentialSource === "paperclip_vault" && Boolean(automaticOAuthMethod(requestedEntry));
    const vercelUnavailable = isVercelConnectUnavailable({
      credentialSource,
      available: galleryQuery.data.credentialSources?.vercelConnect.available === true,
      retainedReconnectMatches: Boolean(reconnectConnectionId && reconnectSourceMatches),
    });
    const unsupportedOAuth = methods.length === 1
      && method?.auth === "oauth"
      && !connectionMethodSupportsAutomaticOAuth(method)
      && !connectionMethodAcceptsCustomerOAuthClient(method);
    if (!requestedEntry || methods.length === 0 || unsupportedOAuth || vercelUnavailable || requestedEntry.availability?.available === false) {
      setEntry(null);
      setStep("gallery");
      if (reconnectConnectionId) return;
      navigate(
        credentialSource === "vercel_connect" ? vercelConnectSourceHref() : "/apps/connect",
        { replace: true },
      );
      return;
    }

    if (entry?.slug !== requestedEntry.slug) {
      setEntry(requestedEntry);
      setGalleryName(requestedEntry.name);
      setLinkUrl("");
      setLinkName("");
      setLinkNeedsKey(false);
      setLinkKey("");
      setCredentials({});
      setCuratedOAuthClientId("");
      setCuratedOAuthClientSecret("");
      setVercelConnector("");
      const initialMethod = recommendedSetupConnectionMethod(methods);
      setConnectionMethodKey(initialMethod?.key ?? "");
      setConfigValues(defaultMethodConfig(initialMethod));
      setGoogleSheetsLinks("");
      setGoogleSheetsError(null);
      setConnectResult(null);
      setGrantKind(reconnectGrantKind ?? defaultGrantKindFor(initialMethod));
      setInstallAgentIds(new Set(requestedAgentId ? [requestedAgentId] : []));
      setInstallChoice(requestedAgentId ? "specific" : "all");
      // Route/service selection initializes the wizard once. Later renders must
      // preserve the user's current step in both hosts instead of snapping back
      // to Access after they continue.
      setStep(resumeConnectionId ? "key" : "access");
    }

    if (automaticOAuth && (
      !applicationsQuery.isFetchedAfterMount ||
      !connectionsQuery.isFetchedAfterMount
    )) return;
    if (automaticOAuth && directOAuthRetryingRef.current) return;
    if (automaticOAuth && (applicationsQuery.isError || connectionsQuery.isError)) {
      setOAuthPhase("error");
      setOAuthError("Paperclip couldn’t check for an existing connection. Try again.");
      setStep("key");
      return;
    }
  }, [
    applicationsQuery.isError,
    applicationsQuery.isFetchedAfterMount,
    applicationsQuery.data,
    connectionsQuery.isError,
    connectionsQuery.isFetchedAfterMount,
    credentialSource,
    entry?.slug,
    galleryQuery.data,
    galleryQuery.isLoading,
    navigate,
    reconnectGrantKind,
    reconnectConnection,
    reconnectConnectionId,
    reconnectSourceMatches,
    resumeConnectionId,
    requestedAppKey,
    requestedAgentId,
  ]);

  // Resume the exact method and non-secret provider configuration that the
  // interrupted draft already chose. Secrets are intentionally never read back
  // into the browser; credential-based methods ask for a replacement value.
  useEffect(() => {
    hydratedResumeConnectionIdRef.current = null;
    setHydratedResumeConnectionId(null);
  }, [resumeConnectionId]);

  useEffect(() => {
    if (
      !resumeConnection
      || !entry
      || resumeConnection.status !== "draft"
      || hydratedResumeConnectionIdRef.current === resumeConnection.id
    ) return;
    const storedConfig = resumeConnection.config && typeof resumeConnection.config === "object"
      ? resumeConnection.config
      : {};
    const storedSource = typeof storedConfig.sourceTemplateKey === "string"
      ? storedConfig.sourceTemplateKey
      : null;
    if (storedSource && storedSource !== entry.slug) return;

    const storedMethodKey = typeof storedConfig.connectionMethodKey === "string"
      ? storedConfig.connectionMethodKey
      : null;
    const resumedMethod = storedMethodKey
      ? connectionMethodsForCredentialSource(entry, credentialSource).find(
          (candidate) => candidate.key === storedMethodKey,
        ) ?? null
      : null;
    setGalleryName(resumeConnection.name || entry.name);
    if (resumedMethod) {
      setConnectionMethodKey(resumedMethod.key);
      const storedMethodConfig = storedConfig.methodConfig && typeof storedConfig.methodConfig === "object"
        ? storedConfig.methodConfig as Record<string, unknown>
        : {};
      setConfigValues({
        ...defaultMethodConfig(resumedMethod),
        ...Object.fromEntries(
          Object.entries(storedMethodConfig).filter(
            (entry): entry is [string, string | boolean] =>
              typeof entry[1] === "string" || typeof entry[1] === "boolean",
          ),
        ),
      });
    }
    const storedOAuth = storedConfig.oauth && typeof storedConfig.oauth === "object"
      ? storedConfig.oauth as Record<string, unknown>
      : null;
    // Only an operator-owned client belongs in the editable Advanced fields.
    // Rehydrating a DCR/CIMD client id there would submit it as customer-owned
    // and corrupt the automatic registration's provenance on the next click.
    if (
      storedOAuth?.clientRegistrationSource === "manual"
      && typeof storedOAuth.clientId === "string"
    ) {
      setCuratedOAuthClientId(storedOAuth.clientId);
    }
    // A draft exists only after the first half of setup has been saved. Resume
    // at the credential/provider checkpoint instead of asking for identity and
    // agent reach again. Automatic OAuth renders the dedicated one-action
    // screen; configured methods render their saved setup form with secrets
    // intentionally blank.
    if (oauthCallbackOutcome === "failed" || oauthCallbackOutcome === "denied") {
      setOAuthPhase("error");
      setOAuthError(
        oauthCallbackOutcome === "denied"
          ? "Authorization was cancelled or declined. Your saved connection was not changed."
          : "Authorization did not complete. Your saved connection is still here, so you can try again.",
      );
    } else {
      setOAuthPhase("entry");
      setOAuthError(null);
    }
    setStep("key");
    hydratedResumeConnectionIdRef.current = resumeConnection.id;
    setHydratedResumeConnectionId(resumeConnection.id);
  }, [credentialSource, entry, oauthCallbackOutcome, resumeConnection]);

  /**
   * Commit the connection: action defaults, agent reach, and installs.
   *
   * Takes the connect result and the enabled set as arguments rather than
   * reading them from state. The Access step removed the separate who/install
   * screens, so this now runs in the same tick as the `setConnectResult` /
   * `setEnabled` that precede it, where that state has not been applied yet.
   */
  const finishMutation = useMutation({
    mutationFn: async (input: { result: ConnectToolAppResult; enabled: Record<string, boolean> }) => {
      const { result: connected, enabled: enabledMap } = input;
      const enabledIds = Object.entries(enabledMap)
        .filter(([, on]) => on)
        .map(([id]) => id);
      const askFirstRiskLevels = new Set(
        Array.isArray(connected.suggestedDefaults.askFirstRiskLevels)
          ? connected.suggestedDefaults.askFirstRiskLevels.filter(
            (riskLevel): riskLevel is string => typeof riskLevel === "string",
          )
          : [],
      );
      const askFirstIds = connected.actions.canMakeChanges
        .filter((action) => enabledMap[action.catalogEntryId] && askFirstRiskLevels.has(action.riskLevel))
        .map((action) => action.catalogEntryId);
      // The Access step asks one question about agent reach, so profile access
      // and installs are committed to the same target set instead of drifting
      // apart behind two separate wizard screens.
      const selection: AppAccessSelection = installChoice === "all"
        ? "all_agents"
        : { agentIds: Array.from(installAgentIds) };
      const finished = await toolsApi.finishApp(selectedCompanyId!, connected.connectionId, {
        enabledCatalogEntryIds: enabledIds,
        askFirstCatalogEntryIds: askFirstIds,
        access: selection,
      });
      await applyAccessInstalls(connected.connectionId);
      return finished;
    },
    onSuccess: (_finished, input) => {
      setAppStep("success");
      onComplete?.({ connectionId: input.result.connectionId });
    },
    onError: (error) => {
      // Creation must feel transactional: a failed commit returns the operator
      // to Access with their identity and agent selections intact rather than
      // stranding them on a half-made connection.
      setAppStep("access");
      pushToast({
        title: "Couldn’t finish setup",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to connect apps.</div>;
  }

  if (resumeConnectionId && connectionsQuery.isFetchedAfterMount && !resumeConnection) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">This setup can’t be resumed</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The saved connection no longer exists or is not available to this company.
        </p>
        <Button type="button" variant="outline" className="mt-5" onClick={() => navigate("/apps")}>
          Back to apps
        </Button>
      </div>
    );
  }

  if (
    reconnectConnectionId
    && connectionsQuery.isFetchedAfterMount
    && applicationsQuery.isFetchedAfterMount
    && (!reconnectConnection || !reconnectSourceMatches)
  ) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">This connection can’t be reconnected</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {!reconnectConnection
            ? "The retained connection no longer exists or is not available to this company."
            : "This reconnect link does not match the retained connection's provider."}
        </p>
        <Button type="button" variant="outline" className="mt-5" onClick={() => navigate("/apps")}>
          Back to apps
        </Button>
      </div>
    );
  }

  if (resumeConnectionId && (
    !connectionsQuery.isFetchedAfterMount
    || galleryQuery.isLoading
    || !entry
    || hydratedResumeConnectionId !== resumeConnection?.id
  )) {
    return (
      <div className="mx-auto max-w-xl space-y-4" aria-label="Loading saved connection setup">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (reconnectConnectionId && (
    !connectionsQuery.isFetchedAfterMount
    || !applicationsQuery.isFetchedAfterMount
    || galleryQuery.isLoading
    || !entry
  )) {
    return (
      <div className="mx-auto max-w-xl space-y-4" aria-label="Loading retained connection setup">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (showConnectionChoice && onUseExisting) {
    return (
      <div className="max-w-5xl" data-testid="connection-existing-choice">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">
            Use an existing {requestedAppKey ? "connection" : "app connection"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reuse a connection without changing who already has access, or connect a new one.
          </p>
        </div>
        <div className="space-y-2">
          {existingConnections.map((connection) => (
            <button
              key={connection.id}
              type="button"
              className="flex w-full items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              disabled={existingConnectionPendingId !== null}
              onClick={async () => {
                setExistingConnectionPendingId(connection.id);
                setExistingConnectionError(null);
                try {
                  await onUseExisting(connection.id);
                } catch (error) {
                  setExistingConnectionError(error instanceof Error ? error.message : "Couldn’t use this connection.");
                  setExistingConnectionPendingId(null);
                }
              }}
            >
              <span>
                <span className="block font-medium text-foreground">{connection.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {connection.status === "active" && connection.enabled ? "Ready to use" : "Setup needs attention"}
                </span>
              </span>
              {existingConnectionPendingId === connection.id ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          ))}
        </div>
        {existingConnectionError ? (
          <InlineBanner tone="danger" className="mt-4">{existingConnectionError}</InlineBanner>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setShowConnectionChoice(false)}>
            Connect new
          </Button>
          {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        </div>
      </div>
    );
  }

  const showCuratedOAuthState = Boolean(
    automaticOAuthEntry
    && step === "key"
    && (directOAuthEntry || oauthPhase !== "entry"),
  );

  if (showCuratedOAuthState && automaticOAuthEntry) {
    return (
      <OAuthConnectStateScreen
        entry={automaticOAuthEntry}
        resuming={Boolean(resumeConnectionId)}
        phase={oauthPhase}
        error={oauthError}
        authorizationHost={authorizationHost}
        onRetry={async () => {
          setOAuthError(null);
          setOAuthPhase("starting");
          const connection = connectResult?.connection ?? resumableOAuthConnection;
          if (connection) {
            startOAuth(connection);
            return;
          }

          // The create request may have reached the server even when its
          // response did not reach the browser. Re-read both resources before
          // creating again so Retry resumes that durable draft instead of
          // duplicating it.
          directOAuthRetryingRef.current = true;
          try {
            const [applicationsResult, connectionsResult] = await Promise.all([
              applicationsQuery.refetch(),
              connectionsQuery.refetch(),
            ]);
            if (applicationsResult.isError || connectionsResult.isError) {
              setOAuthPhase("error");
              setOAuthError("Paperclip couldn’t check for an existing connection. Try again.");
              return;
            }
            const refreshedResumeConnection = resumeConnectionId
              ? (connectionsResult.data?.connections ?? []).find(
                  (candidate) => candidate.id === resumeConnectionId && candidate.authKind === "oauth",
                ) ?? null
              : null;
            const refreshedConnection = refreshedResumeConnection ?? reusableOAuthConnection(
              directOAuthSource,
              applicationsResult.data?.applications ?? [],
              connectionsResult.data?.connections ?? [],
              createNewConnection
                ? { applicationId: prefill.applicationId, draftOnly: true }
                : {},
            );
            if (!directOAuthAccessConfirmedRef.current && !resumeConnectionId) {
              if (refreshedConnection) {
                setGrantKind(refreshedConnection.credentialPolicy === "per_user" ? "user" : "organization");
              }
              setOAuthPhase("entry");
              setOAuthError(null);
              setStep("access");
              return;
            }
            if (refreshedConnection) {
              startOAuth(refreshedConnection);
            } else {
              connectMutation.mutate(automaticOAuthEntry);
            }
          } finally {
            directOAuthRetryingRef.current = false;
          }
        }}
        onCancel={onCancel ?? (() => navigate("/apps/browse"))}
      />
    );
  }

  // A pasted endpoint that needs browser sign-in gets the same waiting/retry
  // screen a curated OAuth app does, minus the branding it doesn't have.
  if (genericOAuthPending && !entry && linkUrl && step === "key") {
    return (
      <OAuthConnectStateScreen
        identity={{
          name: linkName.trim() || endpointHost(linkUrl) || "this server",
          unverifiedHost: endpointHost(linkUrl),
        }}
        phase={oauthPhase}
        error={oauthError}
        authorizationHost={authorizationHost}
        onRetry={() => {
          setOAuthError(null);
          const connection = connectResult?.connection;
          if (connection) {
            setOAuthPhase("starting");
            startOAuth(connection);
            return;
          }
          // No draft to resume, so fall back to the setup screen rather than
          // creating a second connection for the same endpoint.
          setGenericOAuthPending(false);
          setOAuthPhase("entry");
        }}
        onCancel={() => {
          setGenericOAuthPending(false);
          setOAuthPhase("entry");
          setOAuthError(null);
        }}
      />
    );
  }

  const appName =
    connectResult?.application.name ??
    entry?.name ??
    (linkName.trim() || defaultGenericMcpName(linkUrl) || "this app");
  const credentialSourceMethods = connectionMethodsForCredentialSource(entry, credentialSource);
  const credentialSourceApps = vercelConnectMode
    ? (galleryQuery.data?.apps ?? []).filter(
        (app) => connectionMethodsForCredentialSource(app, credentialSource).length > 0,
      )
    : galleryQuery.data?.apps ?? [];
  const zapierEntry = zapierSource
    ? galleryQuery.data?.apps.find((app) => app.slug === "zapier") ?? null
    : null;
  const stepLabels = zapierSource
    ? ZAPIER_STEP_LABELS
    : entry && credentialSourceMethods.length > 1
      ? ["Pick app", "Access", "Choose connection"]
    : entry && credentialSourceMethods[0]?.auth === "oauth"
      ? ["Pick app", "Access", "Sign in"]
    : isGoogleSheetsRobotMethod(entry, connectionMethodKey)
      ? ["Pick app", "Access", "Share sheet"]
      : STEP_LABELS;
  // The Access step's identity question only makes sense when there *is* a
  // credential, so it reads the selected method's auth kind.
  const accessStepMethod = entry
    ? (connectionMethodKey
        ? credentialSourceMethods.find((m) => m.key === connectionMethodKey) ?? null
        : credentialSourceMethods[0] ?? null)
    : null;
  const accessStepAuthKind: ToolConnectionAuthKind = entry
    ? accessStepMethod?.auth ?? "none"
    : linkAuthMode === "none"
      ? "none"
      : linkAuthMode === "oauth"
        ? "oauth"
        : "api_key";
  // The primary label names the next effect, so an OAuth handoff never arrives
  // unannounced.
  const accessMethodIsKnown = !entry
    || Boolean(connectionMethodKey)
    || credentialSourceMethods.length === 1;
  const accessSubmitLabel = accessStepAuthKind === "oauth" && accessMethodIsKnown
    ? `Continue to ${entry?.name ?? "sign-in"}`
    : "Save and continue";

  const stepIndex = zapierSource && step !== "gallery" && step !== "success"
    ? ZAPIER_STEP_INDEX[step]
    : step === "success"
      ? stepLabels.length
      : STEP_INDEX[step];

  return (
    <div className="max-w-5xl">
      {step !== "success" && (
        !(byoOnly && step === "gallery") && (
          <StepHeader
            subtitle={
              step === "gallery"
                ? vercelConnectMode
                  ? "Choose a reviewed app to connect through Vercel."
                  : "Pick the app you want your agents to use."
                : `Step ${stepIndex + 1} of ${stepLabels.length}`
            }
            step={step}
            activeIndex={stepIndex}
            labels={stepLabels}
            appIdentity={
              zapierSource
                ? { name: "Zapier", logoUrl: zapierEntry?.branding.logoUrl ?? null, darkLogoUrl: zapierEntry?.branding.darkLogoUrl ?? null }
                : entry && step !== "gallery"
                  ? { name: entry.name, logoUrl: entry.branding.logoUrl, darkLogoUrl: entry.branding.darkLogoUrl ?? null }
                : undefined
            }
            unverifiedHost={!entry && !zapierSource && step !== "gallery" ? endpointHost(linkUrl) : null}
            onCancel={onCancel ?? (() => navigate("/apps"))}
          />
        )
      )}

      {step === "gallery" && (
        <GalleryStep
          loading={galleryQuery.isLoading}
          apps={credentialSourceApps}
          vercelConnect={vercelConnectMode}
          vercelConnectAvailability={galleryQuery.data?.credentialSources?.vercelConnect ?? null}
          byo={byo}
          byoOnly={byoOnly}
          source={searchParams.get("source")}
          onPick={useMatchedGalleryEntry}
          onUseLink={(url) => {
            const matchedEntry = getAppDefinitionForUrl(url, galleryQuery.data?.apps ?? []);
            setEntry(null);
            setGalleryName("");
            setLinkUrl(url);
            setLinkName(matchedEntry?.name ?? defaultGenericMcpName(url) ?? "");
            setLinkNeedsKey(false);
            setLinkKey("");
            setCredentials({});
            setGoogleSheetsLinks("");
            setGoogleSheetsError(null);
            setInstallAgentIds(new Set());
            setInstallChoice("all");
            setGrantKind(reconnectGrantKind ?? "organization");
            setStep("key");
          }}
          onRunYourOwn={() => navigate(advancedTabHref("run-your-own"))}
          onPasteConfig={() => navigate(advancedTabHref("paste-config"))}
        />
      )}

      {step === "key" && entry && (
        <KeyStep
          entry={entry}
          name={galleryName}
          onNameChange={setGalleryName}
          values={credentials}
          onChange={setCredentials}
          oauthClientId={curatedOAuthClientId}
          onOAuthClientIdChange={setCuratedOAuthClientId}
          oauthClientSecret={curatedOAuthClientSecret}
          onOAuthClientSecretChange={setCuratedOAuthClientSecret}
          credentialSource={credentialSource}
          vercelConnector={vercelConnector}
          onVercelConnectorChange={setVercelConnector}
          vercelConnectAvailability={galleryQuery.data?.credentialSources?.vercelConnect ?? null}
          methodKey={connectionMethodKey}
          onMethodChange={(nextMethod) => {
            setConnectionMethodKey(nextMethod?.key ?? "");
            if (!reconnectGrantKind) {
              setGrantKind(defaultGrantKindFor(nextMethod));
            }
            setCredentials({});
            setCuratedOAuthClientId("");
            setCuratedOAuthClientSecret("");
            setVercelConnector("");
            setConfigValues(defaultMethodConfig(nextMethod));
          }}
          configValues={configValues}
          onConfigChange={setConfigValues}
          googleSheetsLinks={googleSheetsLinks}
          googleSheetsError={googleSheetsError}
          onGoogleSheetsLinksChange={(next) => {
            setGoogleSheetsLinks(next);
            setGoogleSheetsError(null);
          }}
          submitting={connectMutation.isPending}
          // Back returns to Access, not to the gallery: the design requires the
          // identity and agent selections to survive moving backward, and
          // `openGallery` resets them.
          onBack={() => {
            if (resumeConnectionId || reconnectConnectionId) {
              navigate("/apps");
              return;
            }
            setAppStep("access");
          }}
          onConnect={() => {
            if (isGoogleSheetsRobotMethod(entry, connectionMethodKey)) {
              const parsed = parseGoogleSheetIds(googleSheetsLinks);
              if (parsed.invalidCount > 0) {
                setGoogleSheetsError("That doesn't look like a Google Sheets link.");
                return;
              }
              if (parsed.ids.length === 0) {
                setGoogleSheetsError("Paste at least one Google Sheets link.");
                return;
              }
            }
            const selectedMethod = getAvailableConnectionMethod(entry, connectionMethodKey || null);
            const selectedMethodHasProviderFields = Boolean(
              selectedMethod?.credentialFields?.length
              || selectedMethod?.tenantFields?.some((field) => !field.hidden)
              || selectedMethod?.extensionFields?.some((field) => !field.hidden),
            );
            if (
              selectedMethod
              && connectionMethodSupportsAutomaticOAuth(selectedMethod)
              && resumableOAuthConnection
              && !selectedMethodHasProviderFields
              && !curatedOAuthClientId.trim()
            ) {
              directOAuthAccessConfirmedRef.current = true;
              setOAuthError(null);
              setOAuthPhase("starting");
              startOAuth(resumableOAuthConnection);
              return;
            }
            if (selectedMethod && connectionMethodSupportsAutomaticOAuth(selectedMethod)) {
              directOAuthAccessConfirmedRef.current = true;
              setOAuthError(null);
              setOAuthPhase("starting");
            }
            connectApp();
          }}
        />
      )}

      {step === "key" && !entry && linkUrl && !zapierSource && (
        <LinkConnectStep
          link={linkUrl}
          name={linkName}
          onNameChange={setLinkName}
          needsKey={linkNeedsKey}
          onNeedsKeyChange={(next) => {
            setLinkNeedsKey(next);
            if (!next) setLinkKey("");
          }}
          keyValue={linkKey}
          onKeyChange={setLinkKey}
          authMode={linkAuthMode}
          onAuthModeChange={(next) => {
            setLinkAuthMode(next);
            setLinkGuidance(null);
            // Leaving the simple path means the explicit choice governs; drop the
            // "does it need a key?" answer so the two can't disagree.
            if (next !== "auto") setLinkNeedsKey(false);
            if (next !== "bearer" && next !== "auto") setLinkKey("");
          }}
          headers={linkHeaders}
          onHeadersChange={(next) => {
            setLinkHeaders(next);
            setLinkGuidance(null);
          }}
          oauthClientId={linkOAuthClientId}
          onOAuthClientIdChange={setLinkOAuthClientId}
          oauthClientSecret={linkOAuthClientSecret}
          onOAuthClientSecretChange={setLinkOAuthClientSecret}
          advancedOpen={linkAdvancedOpen}
          onAdvancedOpenChange={setLinkAdvancedOpen}
          guidance={linkGuidance}
          matchedEntry={linkMatchedEntry}
          onUseMatchedEntry={linkMatchedEntry ? () => useMatchedGalleryEntry(linkMatchedEntry) : undefined}
          submitting={connectMutation.isPending || genericOAuthPending}
          onBack={() => setStep("gallery")}
          onConnect={() => {
            setLinkGuidance(null);
            connectMutation.mutate(undefined);
          }}
        />
      )}

      {step === "key" && !entry && zapierSource && (
        <ZapierConnectStep
          link={linkUrl}
          onLinkChange={setLinkUrl}
          submitting={connectMutation.isPending}
          onBack={() => navigate("/apps")}
          onConnect={() => connectMutation.mutate(undefined)}
        />
      )}

      {step === "access" && (
        <AccessStep
          appName={appName}
          providerName={entry?.name ?? appName}
          companyId={selectedCompanyId}
          authKind={accessStepAuthKind}
          grantKinds={fixedGrantKind ? [fixedGrantKind] : accessStepMethod?.grantKinds}
          grantKind={effectiveGrantKind}
          setGrantKind={setGrantKind}
          installChoice={installChoice}
          setInstallChoice={setInstallChoice}
          installAgentIds={installAgentIds}
          setInstallAgentIds={setInstallAgentIds}
          lockedAgentId={requestedAgentId}
          capabilities={galleryQuery.data?.capabilities}
          guidance={accessStepMethod?.guidanceMd}
          warnings={accessStepMethod?.warnings}
          setupPrerequisite={entry?.setupPrerequisite}
          docsUrl={accessStepMethod?.consoleLinks?.docs ?? entry?.docsUrl}
          submitLabel={accessSubmitLabel}
          identityLoading={Boolean(automaticOAuthEntry) && directOAuthLookupPending}
          preserveAgentAccess={Boolean(automaticOAuthEntry && (resumableOAuthConnection || reconnectConnection))}
          pending={connectMutation.isPending || oauthStartMutation.isPending}
          // Leaving Access abandons the app choice entirely, so this resets the
          // draft and returns to the gallery the operator came from.
          onBack={() => (entry || linkUrl ? openGallery() : navigate("/apps"))}
          onContinue={() => {
            if (directOAuthEntry) {
              directOAuthAccessConfirmedRef.current = true;
              setOAuthError(null);
              setOAuthPhase("starting");
              setAppStep("key");
              if (resumableOAuthConnection) startOAuth(resumableOAuthConnection);
              else connectApp(directOAuthEntry);
              return;
            }
            if (entry) setAppStep("key");
            else setStep("key");
          }}
        />
      )}

      {step === "success" && (
        <SuccessStep
          appName={appName}
          logoUrl={entry?.branding.logoUrl}
          darkLogoUrl={entry?.branding.darkLogoUrl}
          summary={accessSummaryLines({
            grantKind: effectiveGrantKind,
            authKind: accessStepAuthKind,
            installChoice,
            installCount: installAgentIds.size,
            enabledCount: Object.values(enabled).filter(Boolean).length,
          })}
          onDone={onCancel ?? (() => navigate("/apps/connections"))}
        />
      )}
    </div>
  );
}

function StepHeader({
  subtitle,
  step,
  activeIndex,
  labels,
  appIdentity,
  unverifiedHost,
  onCancel,
}: {
  subtitle: string;
  step: Step;
  activeIndex: number;
  labels: string[];
  appIdentity?: { name: string; logoUrl: string | null; darkLogoUrl?: string | null };
  /**
   * Host of an unknown remote MCP server. Present for the whole generic flow so
   * the operator can see whose server they are configuring at every step, not
   * just on the screen where they pasted the address.
   */
  unverifiedHost?: string | null;
  onCancel: () => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {appIdentity ? (
            <AppLogo name={appIdentity.name} logoUrl={appIdentity.logoUrl} darkLogoUrl={appIdentity.darkLogoUrl} size={44} />
          ) : null}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {appIdentity ? `Connect ${appIdentity.name}` : "Connect an app"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            {unverifiedHost ? <UnverifiedServerBadge host={unverifiedHost} className="mt-2" /> : null}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {step !== "gallery" && (
        <div className="mt-4">
          <div className="flex gap-2">
            {labels.map((label, i) => (
              <div
                key={label}
                className={cn("h-1 w-20 rounded-full", i <= activeIndex ? "bg-foreground" : "bg-border")}
              />
            ))}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">{labels.join("   ·   ")}</div>
        </div>
      )}
    </div>
  );
}

export function OAuthConnectStateScreen({
  entry,
  identity,
  resuming = false,
  phase,
  error,
  authorizationHost,
  onRetry,
  onCancel,
}: {
  /** A curated app. Omit for a generic endpoint and pass `identity` instead. */
  entry?: AppDefinition | null;
  /** Identity for an unknown remote MCP server: its own name plus its host. */
  identity?: { name: string; unverifiedHost: string | null };
  /** This screen is continuing a durable draft rather than creating a new one. */
  resuming?: boolean;
  phase: OAuthConnectPhase;
  error?: string | null;
  /**
   * Host of the authorization page being opened. A valid HTTPS authorization
   * page can still be a phishing page, so the operator sees exactly which host
   * they are being handed to (PAP-17099).
   */
  authorizationHost?: string | null;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const serverName = entry?.name ?? identity?.name ?? "this server";
  const unverifiedHost = entry ? null : identity?.unverifiedHost ?? null;
  const status = phase === "entry"
    ? {
        title: resuming
          ? `Finish connecting ${serverName}`
          : `Connect ${serverName} to Paperclip`,
        body: resuming
          ? `Your connection is saved. Continue in ${serverName} to approve access; its identity and agent access will stay the same.`
          : `Paperclip will open ${serverName} so you can choose a workspace and approve access.`,
      }
    : phase === "starting"
      ? {
          title: "Preparing secure sign-in",
          body: `Paperclip is creating a secure ${serverName} connection.`,
        }
      : phase === "redirecting"
        ? {
            title: `Opening ${serverName}`,
            body: authorizationHost
              ? `Continue at ${authorizationHost} to choose a workspace and approve access. Only approve access if you recognize that address.`
              : `Continue in ${serverName} to choose a workspace and approve access.`,
          }
        : {
            title: `${serverName} couldn’t connect`,
            body: error ?? "Paperclip couldn’t start secure sign-in. Try again.",
          };

  return (
    <div className="max-w-5xl">
      <StepHeader
        subtitle="Secure MCP sign-in"
        step="key"
        activeIndex={1}
        labels={["Access", "Sign in", "Ready"]}
        appIdentity={entry ? { name: entry.name, logoUrl: entry.branding.logoUrl, darkLogoUrl: entry.branding.darkLogoUrl } : undefined}
        unverifiedHost={unverifiedHost}
        onCancel={onCancel}
      />
      <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8">
        <div className="flex items-start gap-3">
          <span className="mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
            {phase === "error" ? (
              <Link2 className="h-5 w-5 text-destructive" />
            ) : phase === "entry" ? (
              <Lock className="h-5 w-5 text-muted-foreground" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight">{status.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{status.body}</p>
            {unverifiedHost ? <UnverifiedServerBadge host={unverifiedHost} className="mt-2" /> : null}
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2">
          {phase === "error" || phase === "entry" ? (
            <Button type="button" onClick={onRetry}>
              {phase === "entry"
                ? resuming ? `Finish with ${serverName}` : `Continue to ${serverName}`
                : "Try again"}
            </Button>
          ) : (
            <Button type="button" disabled>
              {phase === "redirecting" ? `Opening ${serverName}…` : "Preparing…"}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel}>Back to apps</Button>
        </div>
        <p className="mt-5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
          Your authorization stays in Paperclip’s encrypted secret store.
        </p>
      </div>
    </div>
  );
}

function ZapierConnectStep({
  link,
  onLinkChange,
  submitting,
  onBack,
  onConnect,
}: {
  link: string;
  onLinkChange: (next: string) => void;
  submitting: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  const normalizedLink = normalizeAppLink(link);
  const zapierHostname = normalizedLink ? new URL(normalizedLink).hostname : "";
  const isZapierLink = zapierHostname === "zapier.com" || zapierHostname.endsWith(".zapier.com");

  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8">
      <div className="flex items-start gap-3">
        <span className="mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          <Link2 className="h-5 w-5 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight">Connect Zapier</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Paste the complete MCP URL Zapier gives you, including its token.
          </p>
        </div>
      </div>

      <div className="mt-8">
        <label className="text-sm font-medium text-foreground">Zapier MCP URL</label>
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={link}
          onChange={(event) => onLinkChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isZapierLink && !submitting) onConnect();
          }}
          placeholder="https://mcp.zapier.com/api/v1/connect?token=…"
          className="mt-2 h-11"
          autoFocus
        />
        <p className="mt-2 text-xs text-muted-foreground">
          The token is part of the URL. Paperclip stores it securely and checks the connection before enabling actions.
        </p>
        {link.trim() && !isZapierLink && (
          <p className="mt-2 text-xs text-destructive">Paste a valid Zapier URL to continue.</p>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button onClick={onConnect} disabled={submitting || !isZapierLink}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitting ? "Checking…" : "Check link"}
        </Button>
      </div>
    </div>
  );
}

function GalleryStep({
  loading,
  apps,
  byo = false,
  byoOnly = false,
  vercelConnect = false,
  vercelConnectAvailability = null,
  source = null,
  onPick,
  onUseLink,
  onRunYourOwn,
  onPasteConfig,
}: {
  loading: boolean;
  apps: AppDefinition[];
  /** Entered via the "Connect your own MCP server" card (PAP-12371, Finding C): focus the link path. */
  byo?: boolean;
  /** Canonical BYO page: keep the URL path and alternate methods, without the app gallery. */
  byoOnly?: boolean;
  /** Isolated Vercel catalog: no native-provider or bring-your-own setup paths. */
  vercelConnect?: boolean;
  vercelConnectAvailability?: {
    available: boolean;
    manageUrl: string;
    reason: string | null;
  } | null;
  source?: string | null;
  onPick: (entry: AppDefinition) => void;
  onUseLink: (link: string) => void;
  onRunYourOwn: () => void;
  onPasteConfig: () => void;
}) {
  const [search, setSearch] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkSectionRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const linkInputSelectedRef = useRef(false);

  // Arriving from the BYO card: scroll the URL section into view and select its
  // input so the operator can paste immediately.
  useEffect(() => {
    if (!byo || (loading && !byoOnly) || linkInputSelectedRef.current) return;
    if (!byoOnly) linkSectionRef.current?.scrollIntoView?.({ block: "center" });
    linkInputRef.current?.focus();
    linkInputRef.current?.select();
    linkInputSelectedRef.current = true;
  }, [byo, byoOnly, loading]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => a.name.toLowerCase().includes(q));
  }, [apps, search]);
  const normalizedLink = normalizeAppLink(linkInput);
  const matchedEntry = normalizedLink ? getAppDefinitionForUrl(normalizedLink, apps) : null;
  const zapierSource = source === "zapier";

  const continueWithLink = () => {
    const next = normalizeAppLink(linkInput);
    if (!next) {
      setLinkError("Paste a full http or https link.");
      return;
    }
    setLinkError(null);
    onUseLink(next);
  };

  if (loading && !byoOnly) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {vercelConnect ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-bold tracking-tight">Connect through Vercel</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Create and manage the provider connector in Vercel. Paperclip stores its reference and applies agent access, policy, approval, and audit controls here.
              </p>
            </div>
            {vercelConnectAvailability ? (
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <a href={vercelConnectAvailability.manageUrl} target="_blank" rel="noreferrer">
                  Open Vercel Connect
                  <ArrowUpRight className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            ) : null}
          </div>
          {vercelConnectAvailability?.available === false ? (
            <InlineBanner tone="danger" compact className="mt-4">
              {vercelConnectAvailability.reason ?? "Vercel Connect is unavailable on this instance."}
            </InlineBanner>
          ) : null}
        </div>
      ) : null}

      {!byoOnly && (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps…"
              className="h-11 pl-9"
            />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((app) => {
              const copy = appCopyFor(app.slug, app.description);
              const methods = getAvailableConnectionMethods(app);
              const oauthBlocked = methods.length === 0 || methods.every((candidate) =>
                candidate.auth === "oauth"
                && !connectionMethodSupportsAutomaticOAuth(candidate)
                && !connectionMethodAcceptsCustomerOAuthClient(candidate)
              );
              const unavailable = app.availability?.available === false
                || (vercelConnect && vercelConnectAvailability?.available !== true);
              return (
                <button
                  key={app.slug}
                  type="button"
                  disabled={oauthBlocked || unavailable}
                  title={
                    unavailable
                      ? app.availability?.reason ?? vercelConnectAvailability?.reason ?? undefined
                      : undefined
                  }
                  onClick={() => onPick(app)}
                  className={cn(
                    "flex flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors",
                    oauthBlocked || unavailable ? "cursor-not-allowed opacity-60" : "hover:border-foreground/30 hover:bg-accent/40",
                  )}
                >
                  <AppLogo name={app.name} logoUrl={app.branding.logoUrl} darkLogoUrl={app.branding.darkLogoUrl} size={36} />
                  <div className="mt-3 text-sm font-bold text-foreground">{app.name}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{copy.tagline}</div>
                  <div className="mt-3 text-xs font-semibold text-foreground">
                    {unavailable ? (
                      <span className="text-muted-foreground">
                        {app.availability?.reason ?? vercelConnectAvailability?.reason ?? "Unavailable on this instance."}
                      </span>
                    ) : oauthBlocked ? (
                      <span className="text-muted-foreground">Unavailable</span>
                    ) : (
                      <span>Connect →</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">No apps match “{search}”.</div>
          )}
        </>
      )}

      {!vercelConnect ? <div
        ref={linkSectionRef}
        className={cn(
          "grid gap-4 border-t border-border pt-5 md:grid-cols-(--gtc-13)",
          byo && "-mx-3 rounded-xl border border-primary/40 bg-primary/[0.04] px-3 pb-4 md:mx-0",
        )}
      >
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            {zapierSource ? "Connect Zapier" : byo ? "Connect your own MCP server" : "Connect with a link"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {zapierSource
              ? "Paste the complete MCP URL Zapier gives you, including its token."
              : byo
              ? "Paste your MCP server’s URL and every discovered tool will be available immediately."
              : "Paste a setup link from an app that is not listed here."}
          </p>
          {!zapierSource && (
            <p className="mt-1 text-xs text-muted-foreground">
              Any remote tool URL works here — including a local MCP server like{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">http://127.0.0.1:8848/mcp</code>.
            </p>
          )}
          {matchedEntry && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <AppLogo name={matchedEntry.name} logoUrl={matchedEntry.branding.logoUrl} darkLogoUrl={matchedEntry.branding.darkLogoUrl} size={24} />
                <span className="truncate">This looks like {matchedEntry.name}.</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={matchedEntry.availability?.available === false}
                onClick={() => {
                  setLinkError(null);
                  if (matchedEntry.slug === "zapier") {
                    continueWithLink();
                    return;
                  }
                  onPick(matchedEntry);
                }}
              >
                {matchedEntry.availability?.available === false
                  ? "Not available"
                  : matchedEntry.slug === "zapier"
                    ? "Continue"
                    : `Use ${matchedEntry.name}`}
              </Button>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:min-w-(--sz-360px)">
          <div className="flex gap-2">
            <Input
              ref={linkInputRef}
              type={zapierSource || matchedEntry?.slug === "zapier" ? "password" : "url"}
              autoComplete="off"
              spellCheck={false}
              aria-label="MCP server URL"
              value={linkInput}
              onChange={(e) => {
                setLinkInput(e.target.value);
                setLinkError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") continueWithLink();
              }}
              placeholder={zapierSource ? "https://mcp.zapier.com/api/v1/connect?token=…" : "https://example.com/actions"}
              className="h-10"
            />
            <Button type="button" variant="outline" onClick={continueWithLink}>
              Continue
            </Button>
          </div>
          {linkError && <div className="text-xs text-destructive">{linkError}</div>}
        </div>
      </div> : null}

      {!vercelConnect ? <div className="border-t border-border pt-5">
        <div className="text-sm font-semibold text-foreground">More ways to connect</div>
        <p className="mt-1 text-xs text-muted-foreground">
          For tools that aren’t in the gallery. You’ll need details from the tool’s docs.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <ConnectMethodRow
            icon={TerminalSquare}
            title="Run your own"
            description="Register a command Paperclip runs in your workspace for a tool that isn’t listed."
            onClick={onRunYourOwn}
          />
          <ConnectMethodRow
            icon={ClipboardPaste}
            title="Paste a config"
            description="Already have a setup snippet from a README? Paste it and we’ll connect it."
            onClick={onPasteConfig}
          />
        </div>
      </div> : null}
    </div>
  );
}

function ConnectMethodRow({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{description}</div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function normalizeAppLink(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * The guided universal flow for an unknown remote MCP server (PAP-17087, plan 2).
 *
 * The simple path stays exactly as short as it was — URL, name, "does it need a
 * key?" — because that is all most servers need. Everything protocol-shaped lives
 * behind "Advanced authentication", and no OAuth/DCR/CIMD jargon appears on the
 * consumer path: the operator picks how the server authenticates, not which RFC
 * Paperclip will use to satisfy it.
 *
 * The endpoint host and the "Unverified server" label stay visible the whole way
 * through, so the operator can always see whose server they are about to let
 * agents call.
 */
function LinkConnectStep({
  link,
  name,
  onNameChange,
  needsKey,
  onNeedsKeyChange,
  keyValue,
  onKeyChange,
  authMode,
  onAuthModeChange,
  headers,
  onHeadersChange,
  oauthClientId,
  onOAuthClientIdChange,
  oauthClientSecret,
  onOAuthClientSecretChange,
  advancedOpen,
  onAdvancedOpenChange,
  guidance,
  matchedEntry,
  onUseMatchedEntry,
  submitting,
  onBack,
  onConnect,
}: {
  link: string;
  name: string;
  onNameChange: (next: string) => void;
  needsKey: boolean;
  onNeedsKeyChange: (next: boolean) => void;
  keyValue: string;
  onKeyChange: (next: string) => void;
  authMode: GenericMcpAuthMode;
  onAuthModeChange: (next: GenericMcpAuthMode) => void;
  headers: CustomHeaderRow[];
  onHeadersChange: (next: CustomHeaderRow[]) => void;
  oauthClientId: string;
  onOAuthClientIdChange: (next: string) => void;
  oauthClientSecret: string;
  onOAuthClientSecretChange: (next: string) => void;
  advancedOpen: boolean;
  onAdvancedOpenChange: (next: boolean) => void;
  guidance: GenericConnectGuidance | null;
  /** A curated app whose endpoint matches, offered as a convenience only. */
  matchedEntry?: AppDefinition | null;
  onUseMatchedEntry?: () => void;
  submitting: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  const host = endpointHost(link);
  const headerError = authMode === "custom_headers" ? customHeaderError(headers) : null;
  const draft: GenericConnectDraft = {
    link,
    name,
    authMode,
    needsKey,
    keyValue,
    headers,
    oauthClientId,
    oauthClientSecret,
  };
  const canSubmit = canSubmitGenericConnect(draft);
  const showSimpleKeyQuestion = authMode === "auto";
  const nameInputRef = useRef<HTMLInputElement>(null);
  const displayedLink = matchedEntry?.slug === "zapier" ? redactUrlSecrets(link) : link;

  useEffect(() => {
    if (guidance?.focus === "name") nameInputRef.current?.focus();
  }, [guidance]);

  const updateHeader = (id: string, patch: Partial<CustomHeaderRow>) => {
    onHeadersChange(headers.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8">
      <div className="flex items-start gap-3">
        <span className="mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          <Link2 className="h-5 w-5 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight">Connect your own MCP server</h2>
          <p className="mt-1 truncate font-mono text-sm text-muted-foreground" title={displayedLink}>{displayedLink}</p>
          <UnverifiedServerBadge host={host} className="mt-2" />
        </div>
      </div>

      {matchedEntry && onUseMatchedEntry ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <AppLogo name={matchedEntry.name} logoUrl={matchedEntry.branding.logoUrl} darkLogoUrl={matchedEntry.branding.darkLogoUrl} size={24} />
            <span className="truncate">Paperclip has a guided setup for {matchedEntry.name}.</span>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onUseMatchedEntry}>
            Use {matchedEntry.name}
          </Button>
        </div>
      ) : null}

      {guidance ? (
        <div className="mt-6">
          <InlineBanner tone="warning" title={guidance.title}>
            {guidance.body}
          </InlineBanner>
        </div>
      ) : null}

      <div className="mt-8 space-y-6">
        <div>
          <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-name">Name</label>
          <Input
            ref={nameInputRef}
            id="generic-mcp-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="My app"
            className="mt-2 h-11"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            We filled this in from the address. Change it if you'd like.
          </p>
        </div>

        {showSimpleKeyQuestion && (
          <div>
            <label className="mr-2 text-sm font-medium text-foreground">Does it need a key?</label>
            <div className="mt-2 inline-flex rounded-lg border border-border bg-muted/50 p-1">
              <SegmentedOption
                label="No"
                selected={!needsKey}
                onClick={() => onNeedsKeyChange(false)}
              />
              <SegmentedOption
                label="Yes"
                selected={needsKey}
                onClick={() => onNeedsKeyChange(true)}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {needsKey
                ? "Paste the key this app gave you."
                : "Most servers just work from the address — pick Yes only if the server gave you a key, or if it asks you to sign in."}
            </p>
          </div>
        )}

        {(showSimpleKeyQuestion && needsKey) || authMode === "bearer" ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-key">App key</label>
              <Input
                id="generic-mcp-key"
                type="password"
                autoComplete="off"
                value={keyValue}
                onChange={(e) => onKeyChange(e.target.value)}
                placeholder="••••••••••••••••"
                className="mt-2 h-11 font-mono"
              />
            </div>
            <StoredSecurelyNote />
          </div>
        ) : null}

        <Collapsible open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-left text-sm font-medium text-foreground hover:bg-accent/40">
            Advanced authentication
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-5 pt-4">
            <p className="text-xs text-muted-foreground">
              Only needed when the server's docs are specific about how to authenticate.
            </p>
            <div className="flex flex-wrap gap-2">
              {GENERIC_AUTH_MODE_OPTIONS.map((option) => (
                <SegmentedOption
                  key={option.mode}
                  label={option.label}
                  selected={authMode === option.mode}
                  onClick={() => onAuthModeChange(option.mode)}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {GENERIC_AUTH_MODE_OPTIONS.find((option) => option.mode === authMode)?.hint}
            </p>

            {authMode === "custom_headers" ? (
              <div className="space-y-3">
                {headers.map((row) => (
                  <div key={row.id} className="flex items-start gap-2">
                    <Input
                      value={row.name}
                      onChange={(e) => updateHeader(row.id, { name: e.target.value })}
                      placeholder="Header name"
                      aria-label="Header name"
                      className="h-10 font-mono"
                    />
                    <Input
                      type="password"
                      autoComplete="off"
                      value={row.value}
                      onChange={(e) => updateHeader(row.id, { value: e.target.value })}
                      placeholder="Value"
                      aria-label={row.name.trim() ? `Value for ${row.name.trim()}` : "Header value"}
                      className="h-10 font-mono"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-10 shrink-0"
                      onClick={() => onHeadersChange(headers.filter((candidate) => candidate.id !== row.id))}
                      disabled={headers.length === 1}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onHeadersChange([...headers, newCustomHeaderRow()])}
                >
                  Add another header
                </Button>
                {headerError ? <p className="text-xs text-destructive">{headerError}</p> : null}
                <StoredSecurelyNote />
              </div>
            ) : null}

            {authMode === "oauth" ? (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Paperclip sets sign-in up on its own whenever the server allows it. Only fill these in when the
                  server's docs tell you to register Paperclip yourself first.
                </p>
                <div>
                  <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-client-id">
                    Client ID
                  </label>
                  <Input
                    id="generic-mcp-client-id"
                    value={oauthClientId}
                    onChange={(e) => onOAuthClientIdChange(e.target.value)}
                    autoComplete="off"
                    placeholder="Optional"
                    className="mt-2 h-11 font-mono"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-client-secret">
                    Client secret
                  </label>
                  <Input
                    id="generic-mcp-client-secret"
                    type="password"
                    autoComplete="off"
                    value={oauthClientSecret}
                    onChange={(e) => onOAuthClientSecretChange(e.target.value)}
                    placeholder="Optional"
                    className="mt-2 h-11 font-mono"
                  />
                </div>
                <StoredSecurelyNote />
              </div>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            We'll check the server before turning anything on.
          </span>
          <Button onClick={onConnect} disabled={submitting || !canSubmit || Boolean(headerError)}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? "Checking…" : "Check link"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * What the operator is choosing is how the *server* authenticates, in its own
 * terms. Paperclip decides internally whether that means a preconfigured client,
 * a client ID metadata document, dynamic registration, or the credentials pasted
 * below — none of which belongs on this screen.
 */
const GENERIC_AUTH_MODE_OPTIONS: Array<{ mode: GenericMcpAuthMode; label: string; hint: string }> = [
  {
    mode: "auto",
    label: "Let Paperclip check",
    hint: "Paperclip asks the server what it needs and walks you through it. Start here.",
  },
  {
    mode: "none",
    label: "No sign-in needed",
    hint: "The server is open to anyone with the address.",
  },
  {
    mode: "bearer",
    label: "Key or token",
    hint: "Paperclip sends your key as an Authorization header.",
  },
  {
    mode: "custom_headers",
    label: "Custom headers",
    hint: "For servers that name their own headers. Values are stored as Paperclip secrets and can\u2019t be read back.",
  },
  {
    mode: "oauth",
    label: "Browser sign-in",
    hint: "You\u2019ll sign in at the provider. Add a client ID and secret only if the provider requires you to register Paperclip first.",
  },
];

function StoredSecurelyNote() {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-muted/50 p-4">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div>
        <div className="text-sm font-medium text-foreground">Stored securely.</div>
        <div className="text-xs text-muted-foreground">
          Paperclip keeps this in its encrypted secret store. You can replace it anytime from this app's page,
          but it can't be read back.
        </div>
      </div>
    </div>
  );
}

function SegmentedOption({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "min-w-(--sz-64px) rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
        selected
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function ConnectionNameField({
  name,
  onNameChange,
}: {
  name: string;
  onNameChange: (next: string) => void;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-foreground">Name</label>
      <Input
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="My app"
        className="mt-2 h-11"
      />
      <p className="mt-2 text-xs text-muted-foreground">
        We filled this in from the app. Change it to tell connections apart.
      </p>
    </div>
  );
}

function connectionMethodAuthenticationLabel(method: ConnectionMethodDef): string {
  if (method.auth === "api_key") return "Authentication: API key";
  if (method.auth === "none") return "Authentication: no credentials";
  if (connectionMethodSupportsAutomaticOAuth(method)) {
    return connectionMethodAcceptsCustomerOAuthClient(method)
      ? "Authentication: browser sign-in or your OAuth app"
      : "Authentication: browser sign-in";
  }
  return "Authentication: your OAuth app";
}

function KeyStep({
  entry,
  name,
  onNameChange,
  values,
  onChange,
  oauthClientId,
  onOAuthClientIdChange,
  oauthClientSecret,
  onOAuthClientSecretChange,
  credentialSource,
  vercelConnector,
  onVercelConnectorChange,
  vercelConnectAvailability,
  methodKey,
  onMethodChange,
  configValues,
  onConfigChange,
  googleSheetsLinks,
  googleSheetsError,
  onGoogleSheetsLinksChange,
  submitting,
  onBack,
  onConnect,
}: {
  entry: AppDefinition;
  name: string;
  onNameChange: (next: string) => void;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  oauthClientId: string;
  onOAuthClientIdChange: (next: string) => void;
  oauthClientSecret: string;
  onOAuthClientSecretChange: (next: string) => void;
  credentialSource: ToolConnectionCredentialSource;
  vercelConnector: string;
  onVercelConnectorChange: (next: string) => void;
  vercelConnectAvailability: {
    available: boolean;
    manageUrl: string;
    reason: string | null;
  } | null;
  methodKey: string;
  onMethodChange: (method: ConnectionMethodDef | null) => void;
  configValues: Record<string, string | boolean>;
  onConfigChange: (next: Record<string, string | boolean>) => void;
  googleSheetsLinks: string;
  googleSheetsError: string | null;
  onGoogleSheetsLinksChange: (next: string) => void;
  submitting: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  const copy = appCopyFor(entry.slug, entry.description);
  const methods = useMemo(
    () => connectionMethodsForCredentialSource(entry, credentialSource),
    [credentialSource, entry],
  );
  const method = methodKey
    ? methods.find((candidate) => candidate.key === methodKey) ?? null
    : recommendedSetupConnectionMethod(methods);
  const capabilityGroups = useMemo(() => {
    if (!methods.some((candidate) => candidate.capabilityProfile)) return [];
    return Array.from(methods.reduce((groups, candidate) => {
      const key = candidate.capabilityProfile!.key;
      const existing = groups.get(key);
      if (existing) {
        existing.methods.push(candidate);
      } else {
        groups.set(key, {
          key,
          label: candidate.capabilityProfile?.label ?? candidate.label ?? candidate.key,
          description: candidate.capabilityProfile?.description ?? candidate.whenToUse,
          methods: [candidate],
        });
      }
      return groups;
    }, new Map<string, {
      key: string;
      label: string;
      description: string;
      methods: ConnectionMethodDef[];
    }>()),
    ).map(([, group]) => group);
  }, [methods]);
  const selectedMethodCapabilityKey = method?.capabilityProfile?.key ?? method?.key ?? "";
  const capabilityGroupKeys = capabilityGroups.map((group) => group.key).join("|");
  const [capabilityKey, setCapabilityKey] = useState(
    selectedMethodCapabilityKey
      || recommendedSetupConnectionMethod(methods)?.capabilityProfile?.key
      || (capabilityGroups.length === 1 ? capabilityGroups[0]!.key : ""),
  );
  useEffect(() => {
    if (selectedMethodCapabilityKey) {
      setCapabilityKey(selectedMethodCapabilityKey);
      return;
    }
    setCapabilityKey((current) => {
      if (capabilityGroups.some((group) => group.key === current)) return current;
      return recommendedSetupConnectionMethod(methods)?.capabilityProfile?.key
        || (capabilityGroups.length === 1 ? capabilityGroups[0]!.key : "");
    });
  }, [capabilityGroupKeys, capabilityGroups, methods, selectedMethodCapabilityKey]);
  const capabilityMethods = capabilityGroups.length > 1
    ? capabilityGroups.find((group) => group.key === capabilityKey)?.methods ?? []
    : methods;
  const fields = (method?.credentialFields ?? []).map((field) => ({
    ...field,
    configPath: credentialConfigPath(field),
    helpUrl: method?.consoleLinks?.keys ?? method?.consoleLinks?.docs ?? "",
  }));
  const vercelReview = method?.credentialSources?.vercelConnect ?? null;
  const usingVercel = credentialSource === "vercel_connect";
  const allFilled = usingVercel || fields.every(
    (f) => f.required === false || (values[f.configPath]?.trim().length ?? 0) > 0,
  );
  const acceptsCustomerOAuthClient = connectionMethodAcceptsCustomerOAuthClient(method);
  const customerOAuthClientRequired = acceptsCustomerOAuthClient
    && !connectionMethodSupportsAutomaticOAuth(method);
  const oauthClientFilled = usingVercel || !customerOAuthClientRequired || oauthClientId.trim().length > 0;
  const vercelConnectorFilled = !usingVercel || vercelConnector.trim().length > 0;
  const oauthCallbackUrl = method?.auth === "oauth" && acceptsCustomerOAuthClient
    ? oauthCallbackUrlForBrowser()
    : null;
  const allConfigFields = [...(method?.tenantFields ?? []), ...(method?.extensionFields ?? [])];
  const configFields = allConfigFields.filter((field) => !field.hidden);
  const standardConfigFields = configFields.filter((field) => field.advanced !== true);
  const advancedConfigFields = configFields.filter((field) => field.advanced === true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const configFilled = allConfigFields.every((field) => {
    if (!field.required) return true;
    const value = configValues[field.key];
    return typeof value === "boolean" || (typeof value === "string" && value.trim().length > 0);
  });
  const alternativeKeys = method?.configRequirements?.atLeastOneOf ?? [];
  const configRequirementMet = alternativeKeys.length === 0 || alternativeKeys.some((key) => {
    const value = configValues[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  const hasCapabilitySelection = capabilityGroups.length <= 1 || Boolean(capabilityKey);
  const hasMethodSelection = hasCapabilitySelection
    && (capabilityMethods.length <= 1 ? Boolean(method) : Boolean(methodKey));
  const robotEmail = entry.availability?.robotEmail ?? null;
  const unavailable = entry.availability?.available === false;
  const optionalCustomerOAuthClient = !usingVercel
    && acceptsCustomerOAuthClient
    && !customerOAuthClientRequired;
  const hasAdvancedSettings = advancedConfigFields.length > 0 || optionalCustomerOAuthClient;
  const capabilitySelection = capabilityGroups.length > 1 ? (
    <div>
      <label className="text-sm font-medium text-foreground">What should Paperclip be able to do?</label>
      <RadioCardGroup
        ariaLabel={`Access level for ${entry.name}`}
        className="mt-2"
        value={capabilityKey}
        onValueChange={(nextKey) => {
          const nextGroup = capabilityGroups.find((group) => group.key === nextKey);
          if (!nextGroup) return;
          setCapabilityKey(nextKey);
          onMethodChange(getRecommendedConnectionMethod(nextGroup.methods));
        }}
        options={capabilityGroups.map((group) => ({
          value: group.key,
          title: group.label,
          description: group.description,
        }))}
      />
      {!capabilityKey && <p className="mt-2 text-xs text-muted-foreground">Choose an access level to continue.</p>}
    </div>
  ) : null;
  const authenticationSelection = capabilityMethods.length > 1 ? (
    <div>
      <label className="text-sm font-medium text-foreground">How do you want to connect?</label>
      <RadioCardGroup
        ariaLabel={`How to connect ${entry.name}`}
        className="mt-2"
        value={methodKey}
        onValueChange={(nextKey) => {
          const nextMethod = capabilityMethods.find((candidate) => candidate.key === nextKey);
          if (nextMethod) onMethodChange(nextMethod);
        }}
        options={capabilityMethods.map((candidate) => ({
          value: candidate.key,
          title: candidate.label ?? (candidate.auth === "oauth" ? `Sign in with ${entry.name}` : "Use an API key"),
          description: `${connectionMethodAuthenticationLabel(candidate)}. ${candidate.whenToUse}`,
        }))}
      />
      {!method && <p className="mt-2 text-xs text-muted-foreground">Choose a connection method to continue.</p>}
    </div>
  ) : null;

  if (isGoogleSheetsRobotMethod(entry, method)) {
    const parsed = parseGoogleSheetIds(googleSheetsLinks);
    const canConnect = !unavailable && Boolean(robotEmail) && googleSheetsLinks.trim().length > 0;
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8">
        <div className="flex items-center gap-3">
          <AppLogo name={entry.name} logoUrl={entry.branding.logoUrl} darkLogoUrl={entry.branding.darkLogoUrl} size={48} />
          <div>
            <h2 className="text-lg font-bold tracking-tight sm:text-xl">Connect Google Sheets</h2>
            <p className="text-sm text-muted-foreground">{copy.short}</p>
          </div>
        </div>

        <div className="mt-8 space-y-6">
          {capabilitySelection}
          <ConnectionNameField name={name} onNameChange={onNameChange} />

          {robotEmail ? (
            <div>
              <label className="text-sm font-medium text-foreground">Share each sheet with this email</label>
              <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
                <div
                  title={robotEmail}
                  className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-muted/40 px-3 py-2.5 font-mono text-xs leading-tight text-foreground break-all"
                >
                  {robotEmail}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void copyTextToClipboard(robotEmail).catch(() => {})}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                In Google Sheets, click Share and add this email as an Editor. Then paste the sheet links below.
              </p>
            </div>
          ) : (
            <div className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
              Google Sheets is not available on this instance yet.
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-foreground">Paste links to the sheets you shared</label>
            <Textarea
              value={googleSheetsLinks}
              onChange={(e) => onGoogleSheetsLinksChange(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="mt-2 min-h-28"
            />
            <div className="mt-2 text-xs text-muted-foreground">
              {parsed.ids.length > 0
                ? `${parsed.ids.length} ${parsed.ids.length === 1 ? "sheet" : "sheets"} ready to connect.`
                : "Paste one link per line. Both .../edit and .../edit#gid=... links work."}
            </div>
            {googleSheetsError && <div className="mt-2 text-xs text-destructive">{googleSheetsError}</div>}
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={onBack} disabled={submitting}>
            Back
          </Button>
          <Button onClick={onConnect} disabled={submitting || !canConnect}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? "Checking…" : "Connect"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8">
      <div className="flex items-center gap-3">
        <AppLogo name={entry.name} logoUrl={entry.branding.logoUrl} darkLogoUrl={entry.branding.darkLogoUrl} size={48} />
        <div>
          <h2 className="text-xl font-bold tracking-tight">Connect {entry.name}</h2>
          <p className="text-sm text-muted-foreground">{copy.short}</p>
        </div>
      </div>

      <div className="mt-8 space-y-6">
        {capabilitySelection}
        {authenticationSelection}

        {method?.warnings?.map((warning) => (
          <InlineBanner key={warning} tone="warning" compact>
            {warning}
          </InlineBanner>
        ))}

        {method ? (
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <p className="text-sm text-foreground">{method.guidanceMd}</p>
            {entry.docsUrl || method.consoleLinks?.docs ? (
              <a
                href={method.consoleLinks?.docs ?? entry.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
              >
                Review {entry.name} setup requirements
                <ArrowUpRight className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        ) : null}

        {usingVercel && vercelReview && vercelConnectAvailability ? (
          <div className="space-y-4 rounded-lg border border-border p-4">
            <div>
              <div className="text-sm font-medium text-foreground">Create or attach the connector in Vercel</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Paperclip does not copy Vercel’s setup forms. Finish connector setup there, then paste its UID below.
              </p>
              <a
                href={vercelConnectAvailability.manageUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
              >
                Open Vercel Connect
                <ArrowUpRight className="h-3 w-3" />
              </a>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="vercel-connect-connector">
                Connector UID or ID
              </label>
              <Input
                id="vercel-connect-connector"
                value={vercelConnector}
                onChange={(event) => onVercelConnectorChange(event.target.value)}
                autoComplete="off"
                placeholder="service/my-connector or scl_…"
                className="mt-2 h-11 font-mono"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Paperclip validates the connector and stores only its reference and redacted verification metadata.
              </p>
            </div>
          </div>
        ) : null}

        <ConnectionNameField name={name} onNameChange={onNameChange} />

        {standardConfigFields.map((field) => (
          <MethodConfigField
            key={field.key}
            field={field}
            value={configValues[field.key]}
            onChange={(value) => onConfigChange({ ...configValues, [field.key]: value })}
          />
        ))}

        {hasAdvancedSettings && (
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
              Advanced
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4">
              <div className="space-y-6">
                {advancedConfigFields.map((field) => (
                  <MethodConfigField
                    key={field.key}
                    field={field}
                    value={configValues[field.key]}
                    onChange={(value) => onConfigChange({ ...configValues, [field.key]: value })}
                  />
                ))}
                {optionalCustomerOAuthClient ? (
                  <OAuthClientFields
                    entry={entry}
                    method={method!}
                    callbackUrl={oauthCallbackUrl}
                    clientId={oauthClientId}
                    onClientIdChange={onOAuthClientIdChange}
                    clientSecret={oauthClientSecret}
                    onClientSecretChange={onOAuthClientSecretChange}
                    required={false}
                  />
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {!usingVercel && method?.auth === "oauth" && customerOAuthClientRequired ? (
          <OAuthClientFields
            entry={entry}
            method={method}
            callbackUrl={oauthCallbackUrl}
            clientId={oauthClientId}
            onClientIdChange={onOAuthClientIdChange}
            clientSecret={oauthClientSecret}
            onClientSecretChange={onOAuthClientSecretChange}
            required
          />
        ) : null}

        {usingVercel ? null : method && fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {method.auth === "oauth"
              ? `You’ll continue to ${entry.name} to sign in securely.`
              : "This app doesn’t need a key. Just connect to continue."}
          </p>
        ) : (
          fields.map((field) => (
            <div key={field.configPath}>
              <label className="text-sm font-medium text-foreground">
                {credentialFieldLabel(entry.name, field.label, fields.length)}
              </label>
              <Input
                type="password"
                autoComplete="off"
                value={values[field.configPath] ?? ""}
                onChange={(e) => onChange({ ...values, [field.configPath]: e.target.value })}
                placeholder="••••••••••••••••"
                className="mt-2 h-11 font-mono"
              />
              {field.helpUrl && (
                <a
                  href={field.helpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
                >
                  Where do I find this?
                  <ArrowUpRight className="h-3 w-3" />
                </a>
              )}
            </div>
          ))
        )}

        {!usingVercel && method?.auth === "api_key" && (
          <div className="flex items-start gap-3 rounded-lg bg-muted/50 p-4">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium text-foreground">Your key is stored securely.</div>
              <div className="text-xs text-muted-foreground">
                You can replace it anytime from this app’s page.
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {method?.auth === "oauth"
              ? "You’ll sign in before anything turns on."
              : "We’ll check the key before turning anything on."}
          </span>
          <Button onClick={onConnect} disabled={submitting || !hasMethodSelection || !allFilled || !oauthClientFilled || !vercelConnectorFilled || !configFilled || !configRequirementMet}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting
              ? "Checking…"
              : usingVercel
                ? method?.auth === "oauth" ? "Validate and continue" : "Validate and connect"
                : method?.auth === "oauth" ? "Continue to sign in" : "Connect"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function OAuthClientFields({
  entry,
  method,
  callbackUrl,
  clientId,
  onClientIdChange,
  clientSecret,
  onClientSecretChange,
  required,
}: {
  entry: AppDefinition;
  method: ConnectionMethodDef;
  callbackUrl: string | null;
  clientId: string;
  onClientIdChange: (next: string) => void;
  clientSecret: string;
  onClientSecretChange: (next: string) => void;
  required: boolean;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <div className="text-sm font-medium text-foreground">
          {required ? "Your OAuth app" : "Use your own OAuth app"}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Register Paperclip's callback URI in {entry.name}, then enter the customer-owned client details.
        </p>
        {method.consoleLinks?.register ? (
          <a
            href={method.consoleLinks.register}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
          >
            Open {entry.name} app settings
            <ArrowUpRight className="h-3 w-3" />
          </a>
        ) : null}
      </div>
      {callbackUrl ? (
        <div>
          <label className="text-sm font-medium text-foreground">Paperclip callback URL</label>
          <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
            <div
              title={callbackUrl}
              className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-muted/40 px-3 py-2.5 font-mono text-xs leading-tight text-foreground break-all"
            >
              {callbackUrl}
            </div>
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              onClick={() => void copyTextToClipboard(callbackUrl).catch(() => {})}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Add this exact URL to {entry.name} before continuing. It must match the authorization request.
          </p>
        </div>
      ) : null}
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="curated-oauth-client-id">
          Client ID
        </label>
        <Input
          id="curated-oauth-client-id"
          value={clientId}
          onChange={(event) => onClientIdChange(event.target.value)}
          autoComplete="off"
          placeholder={required ? "Required" : "Optional"}
          className="mt-2 h-11 font-mono"
        />
      </div>
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="curated-oauth-client-secret">
          Client secret
        </label>
        <Input
          id="curated-oauth-client-secret"
          type="password"
          value={clientSecret}
          onChange={(event) => onClientSecretChange(event.target.value)}
          autoComplete="off"
          placeholder="Optional for public clients"
          className="mt-2 h-11 font-mono"
        />
      </div>
      <StoredSecurelyNote />
    </div>
  );
}

function MethodConfigField({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <div className="text-sm font-medium text-foreground">{field.label}</div>
          {field.helperMd && <div className="mt-1 text-xs text-muted-foreground">{field.helperMd}</div>}
        </div>
        <ToggleSwitch checked={value === true} onCheckedChange={onChange} />
      </div>
    );
  }
  return (
    <div>
      <label className="text-sm font-medium text-foreground">{field.label}</label>
      {field.type === "textarea" ? (
        <Textarea
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className="mt-2 min-h-24"
        />
      ) : field.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className="mt-2 h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <option value="" disabled>Select an option</option>
          {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className="mt-2 h-11"
        />
      )}
      {field.helperMd && <p className="mt-2 text-xs text-muted-foreground">{field.helperMd}</p>}
    </div>
  );
}

/**
 * Access step (PAP-17835 Surface A).
 *
 * Two binary questions, asked together and *before* any credential is entered,
 * so the reader understands the identity and the reach the secret is about to
 * get. Hick's Law: two choices, not a matrix. Both use full-row radio targets.
 */
export function AccessStep({
  appName,
  providerName,
  companyId,
  authKind,
  grantKinds,
  grantKind,
  setGrantKind,
  installChoice,
  setInstallChoice,
  installAgentIds,
  setInstallAgentIds,
  lockedAgentId,
  capabilities,
  guidance,
  warnings,
  setupPrerequisite,
  docsUrl,
  submitLabel,
  identityLoading = false,
  preserveAgentAccess = false,
  pending = false,
  onBack,
  onContinue,
}: {
  appName: string;
  providerName: string;
  companyId: string;
  authKind: ToolConnectionAuthKind;
  grantKinds?: ConnectionGrantKind[];
  grantKind: ConnectionGrantKind;
  setGrantKind: (kind: ConnectionGrantKind) => void;
  installChoice: "specific" | "all";
  setInstallChoice: (choice: "specific" | "all") => void;
  installAgentIds: Set<string>;
  setInstallAgentIds: (ids: Set<string>) => void;
  /** Task-hosted intents grant reach only to the agent that requested it. */
  lockedAgentId?: string;
  capabilities?: Pick<ToolConnectionCreateCapabilities, "canSetCompanyInstall"> & {
    companyInstallReason?: string | null;
    editableAgentIds?: string[];
  } | null;
  guidance?: string;
  warnings?: string[];
  setupPrerequisite?: AppDefinition["setupPrerequisite"];
  docsUrl?: string;
  submitLabel: string;
  /** Wait for a durable OAuth connection before showing a reconnect identity. */
  identityLoading?: boolean;
  /** Reconnect changes credentials only; existing install reach stays intact. */
  preserveAgentAccess?: boolean;
  pending?: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const allAgents: Agent[] = (agentsQuery.data ?? []).filter((a) => a.status !== "terminated");
  // "Agents I pick" means agents this person may actually edit. When the server
  // has not told us, fall back to every live agent rather than an empty list —
  // an empty picker would read as "you have no agents".
  const editableAgentIds = capabilities?.editableAgentIds;
  const agents = editableAgentIds
    ? allAgents.filter((agent) => editableAgentIds.includes(agent.id))
    : allAgents;
  // Company-wide install is the connection creator's to give. When it is not
  // available the option stays visible and disabled with the reason, so the
  // scope stays legible instead of quietly disappearing.
  const canSetCompanyInstall = capabilities?.canSetCompanyInstall ?? true;
  const needsIdentityChoice = authKind !== "none";
  const allowedGrantKinds = grantKinds ?? (["user", "organization"] satisfies ConnectionGrantKind[]);
  const canContinue = preserveAgentAccess
    ? true
    : lockedAgentId
    ? installAgentIds.has(lockedAgentId)
    : installChoice === "all"
    ? canSetCompanyInstall
    : installAgentIds.size > 0;
  const lockedAgentName = lockedAgentId
    ? allAgents.find((agent) => agent.id === lockedAgentId)?.name ?? "the requesting agent"
    : null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-start gap-3 border-b border-border p-6">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-xl font-bold tracking-tight">
              {authKind === "oauth" ? "Choose access before sign-in" : "Choose access before adding credentials"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {authKind === "oauth"
                ? `Set the identity and agent reach first. Then ${providerName} will ask you to authorize that exact connection.`
                : "Set the identity and agent reach first. Then add the credential for that exact connection."}
            </p>
          </div>
        </div>

        {guidance || warnings?.length || setupPrerequisite || docsUrl ? (
          <div className="space-y-3 border-b border-border p-6">
            {warnings?.map((warning) => (
              <InlineBanner key={warning} tone="warning" compact>{warning}</InlineBanner>
            ))}
            {guidance ? <p className="text-sm text-foreground">{guidance}</p> : null}
            {setupPrerequisite ? (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <h3 className="text-sm font-semibold text-foreground">{setupPrerequisite.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{setupPrerequisite.description}</p>
                {setupPrerequisite.steps?.length ? (
                  <ol
                    aria-label={`${setupPrerequisite.title} steps`}
                    className="mt-3 list-decimal space-y-1 pl-4 text-xs text-muted-foreground"
                  >
                    {setupPrerequisite.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                ) : null}
                <a
                  href={setupPrerequisite.actionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
                >
                  {setupPrerequisite.actionLabel}
                  <ArrowUpRight className="h-3 w-3" />
                </a>
              </div>
            ) : null}
            {docsUrl ? (
              <a
                href={docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
              >
                Review {providerName} setup requirements
                <ArrowUpRight className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        ) : null}

        <div className="divide-y divide-border">
          <section className="p-6">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <UserRound className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Who is this credential for?</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Whose {appName} account should agents act as?
                </p>
              </div>
            </div>
            {identityLoading ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Loading connection identity">
                <Skeleton className="h-20 w-full rounded-md" />
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            ) : needsIdentityChoice && allowedGrantKinds.length === 1 ? (
              <div className="mt-4 flex items-start gap-3 rounded-md border border-border bg-muted/40 p-4">
                {allowedGrantKinds[0] === "user" ? (
                  <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                )}
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {allowedGrantKinds[0] === "user" ? "Just me." : "Everyone in the company"}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {allowedGrantKinds[0] === "user"
                      ? `Agents use this ${appName} identity only when work runs for you.`
                      : `Eligible company members share this ${appName} identity.`}
                    {preserveAgentAccess ? " Reconnect keeps this identity type." : null}
                  </p>
                </div>
              </div>
            ) : needsIdentityChoice ? (
              <RadioCardGroup
                ariaLabel="Who is this credential for?"
                className="mt-4 sm:grid-cols-2"
                value={grantKind}
                onValueChange={(next) => setGrantKind(next as ConnectionGrantKind)}
                options={[
                  {
                    value: "user",
                    title: "Just me",
                    description: "Agents use this identity only when work runs for you.",
                  },
                  {
                    value: "organization",
                    title: "Everyone in the company",
                    description: "Eligible company members use one shared identity.",
                  },
                ].filter((option) => allowedGrantKinds.includes(option.value as ConnectionGrantKind))}
              />
            ) : (
              // A connection with no credential has no identity to choose, so
              // asking would be a meaningless decision.
              <p className="mt-4 text-sm text-muted-foreground">No identity required</p>
            )}
          </section>

          <section className="p-6">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Bot className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Which agents can use this connection?</h3>
                <p className="mt-1 text-xs text-muted-foreground">Choose where this connection will be available.</p>
              </div>
            </div>
            {preserveAgentAccess ? (
              <div className="mt-4 flex items-start gap-3 rounded-md border border-border bg-muted/40 p-4">
                <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <div className="text-sm font-medium text-foreground">Existing agent access stays the same</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Reconnecting replaces the credential without changing which agents can use it.
                  </p>
                </div>
              </div>
            ) : lockedAgentId ? (
              <p className="mt-2 text-sm text-muted-foreground">
                This task grants access only to <span className="font-medium text-foreground">{lockedAgentName}</span>.
                Existing connection access is left unchanged.
              </p>
            ) : (
              <RadioCardGroup
                ariaLabel="Which agents can use this connection?"
                className="mt-4 sm:grid-cols-2"
                value={installChoice}
                onValueChange={(next) => setInstallChoice(next as "specific" | "all")}
                options={[
                  {
                    value: "specific",
                    title: "Agents I pick",
                    description: "Choose one or more agents you can edit.",
                  },
                  {
                    value: "all",
                    title: "Any agent",
                    description: canSetCompanyInstall
                      ? "Make this connection available to every agent."
                      : capabilities?.companyInstallReason ??
                        "Only someone who can configure this connection can choose this.",
                    disabled: !canSetCompanyInstall,
                  },
                ]}
              />
            )}
            {!preserveAgentAccess && !lockedAgentId && installChoice === "specific" ? (
              <div className="mt-3">
                <AgentMultiSelect
                  agents={agents}
                  selectedAgentIds={installAgentIds}
                  onChange={setInstallAgentIds}
                  loading={agentsQuery.isLoading}
                  emptyMessage="You cannot edit any agents yet."
                  showSelectionPreview={false}
                />
              </div>
            ) : null}
          </section>
        </div>
      </div>

      {/* Mobile stacks actions full-width with the primary action first in
          reading order; desktop keeps Back on the left. */}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" className="w-full sm:w-auto" onClick={onBack} disabled={pending}>
          Back
        </Button>
        <Button
          className="w-full sm:w-auto"
          onClick={onContinue}
          disabled={!canContinue || identityLoading || pending}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {submitLabel}
          {!pending && authKind === "oauth" ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
        </Button>
      </div>
    </div>
  );
}

/**
 * Summary of what the Access step committed. Three lines, not badges: identity,
 * reach, and the existing action summary each said once.
 */
export function accessSummaryLines(input: {
  grantKind: ConnectionGrantKind;
  authKind: ToolConnectionAuthKind;
  installChoice: "specific" | "all";
  installCount: number;
  enabledCount: number;
}): Array<{ label: string; value: string }> {
  const identity = input.authKind === "none"
    ? "No identity required"
    : input.grantKind === "user"
      ? "Your identity"
      : "Organization identity";
  const availableTo = input.installChoice === "all"
    ? "Any agent"
    : `${input.installCount} selected ${input.installCount === 1 ? "agent" : "agents"}`;
  return [
    { label: "Identity", value: identity },
    { label: "Available to", value: availableTo },
    {
      label: "Actions",
      value: `${input.enabledCount} ${input.enabledCount === 1 ? "action" : "actions"} on`,
    },
  ];
}

function Radio({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
        selected ? "border-foreground" : "border-muted-foreground/40",
      )}
    >
      {selected && <span className="h-2 w-2 rounded-full bg-foreground" />}
    </span>
  );
}

function SuccessStep({
  appName,
  logoUrl,
  darkLogoUrl,
  summary,
  onDone,
}: {
  appName: string;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
  /** Identity / Available to / Actions, as three lines rather than badges. */
  summary: Array<{ label: string; value: string }>;
  onDone: () => void;
}) {
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 border-emerald-500 bg-emerald-500/10">
        <Check className="h-9 w-9 text-emerald-600 dark:text-emerald-400" />
      </div>
      <div className="mt-6 flex items-center justify-center gap-2">
        <AppLogo name={appName} logoUrl={logoUrl} darkLogoUrl={darkLogoUrl} size={28} />
        <h2 className="text-2xl font-bold tracking-tight">{appName} is ready.</h2>
      </div>
      <dl className="mx-auto mt-6 max-w-xs space-y-1 text-left">
        {summary.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-xs font-medium text-muted-foreground">{line.label}</dt>
            <dd className="text-sm text-foreground">{line.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-8">
        <Button size="lg" className="px-10" onClick={onDone}>
          View connection
        </Button>
      </div>
    </div>
  );
}
