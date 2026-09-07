import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Link2,
  Loader2,
  Lock,
  Search,
  UserRound,
  UsersRound,
} from "lucide-react";
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
  ToolOAuthStartResult,
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
import { prepareOAuthNavigation, savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";
import { AppLogo } from "@/pages/apps/AppLogo";
import { appApplicationSourceSlug, appDefinitionText } from "@/pages/apps/app-definition-display";
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

type EnrollmentAccessState = {
  companyId: string;
  grantKind: ConnectionGrantKind;
  installChoice: "specific" | "all";
  agentIds: string[];
};

function enrollmentAccessStorageKey(appKey: string): string {
  return `paperclip.connector-enrollment-access:${appKey}`;
}

function validEnrollmentAccessState(value: unknown): value is EnrollmentAccessState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.companyId !== "string" || !candidate.companyId.trim()) return false;
  if (!(candidate.grantKind === "user" || candidate.grantKind === "agent" || candidate.grantKind === "organization")) {
    return false;
  }
  if (candidate.installChoice !== "specific" && candidate.installChoice !== "all") return false;
  if (!Array.isArray(candidate.agentIds) || candidate.agentIds.some((id) => typeof id !== "string" || !id.trim())) {
    return false;
  }
  const agentIds = new Set(candidate.agentIds);
  if (agentIds.size !== candidate.agentIds.length) return false;
  if (candidate.grantKind === "agent") {
    return candidate.installChoice === "specific" && agentIds.size === 1;
  }
  return candidate.installChoice === "all" ? agentIds.size === 0 : agentIds.size > 0;
}

function saveEnrollmentAccessState(
  companyId: string,
  appKey: string,
  state: Omit<EnrollmentAccessState, "companyId">,
): void {
  try {
    window.sessionStorage.setItem(enrollmentAccessStorageKey(appKey), JSON.stringify({ ...state, companyId }));
  } catch {
    // Browser storage can be unavailable under restrictive privacy settings.
    // The callback will safely use the provider's defaults in that case.
  }
}

function consumeEnrollmentAccessState(appKey: string): EnrollmentAccessState | null {
  const key = enrollmentAccessStorageKey(appKey);
  try {
    const raw = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return validEnrollmentAccessState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function githubRecoveryUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function oauthCallbackErrorMessage(outcome: string | null, code: string | null): string {
  if (outcome === "denied") {
    return t("localizationConnections.authorizationWasCancelledOrDeclinedYourSavedC1");
  }
  if (code === "github_installation_required") {
    return t("localizationConnections.gitHubAccessIsRequiredInstallPaperclipAndGran2");
  }
  return t("localizationConnections.authorizationDidNotCompleteYourSavedConnectio3");
}

const ROUTE_STAGE_BY_STEP: Partial<Record<Step, string>> = {
  access: "access",
  key: "setup",
  success: "complete",
};

export function requestedConnectionInitialStep(input: {
  requestedAppKey: string | undefined;
  routeStage: string | null;
  resumeConnectionId: string | null;
  hasPrefilledLink: boolean;
  zapierSource: boolean;
}): Step {
  if (input.requestedAppKey) {
    return input.resumeConnectionId || input.routeStage === "setup" ? "key" : "access";
  }
  return input.hasPrefilledLink || input.zapierSource ? "access" : "gallery";
}

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

export function retainedReconnectMatches(input: {
  requestedAppKey: string | undefined;
  byo: boolean;
  applicationId: string | undefined;
  reconnectConnection: ToolConnection | null;
  reconnectApplication: ToolApplication | null;
}): boolean {
  if (
    !input.reconnectConnection
    || !input.reconnectApplication
    || input.reconnectConnection.applicationId !== input.reconnectApplication.id
  ) return false;
  if (input.requestedAppKey) {
    return appApplicationSourceSlug(input.reconnectApplication) === input.requestedAppKey;
  }
  // Generic MCP applications intentionally have no provider slug. Their
  // reconnect URL instead carries the exact retained application identity.
  return input.byo && input.applicationId === input.reconnectApplication.id;
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

export function isConnectionDefinitionUnavailable(input: {
  available: boolean | undefined;
  reconnectConnectionId: string | null | undefined;
  reconnectSourceMatches: boolean;
}): boolean {
  return input.available === false
    && !(input.reconnectConnectionId && input.reconnectSourceMatches);
}

export function requestedConnectionSetupResolution(input: {
  reconnectConnectionId: string | null | undefined;
  hasRequestedEntry: boolean;
  supportedMethodCount: number;
  unsupportedOAuth: boolean;
  vercelUnavailable: boolean;
  definitionUnavailable: boolean;
}): "ready" | "fallback" | "reconnect_unavailable" {
  const unavailable = !input.hasRequestedEntry
    || input.supportedMethodCount === 0
    || input.unsupportedOAuth
    || input.vercelUnavailable
    || input.definitionUnavailable;
  if (!unavailable) return "ready";
  return input.reconnectConnectionId ? "reconnect_unavailable" : "fallback";
}

function appConnectHref(
  appKey: string,
  step: Step,
  credentialSource: ToolConnectionCredentialSource,
  existing?: {
    resumeConnectionId?: string | null;
    reconnectConnectionId?: string | null;
    interactionId?: string | null;
  },
): string {
  const stage = ROUTE_STAGE_BY_STEP[step] ?? "setup";
  const params = new URLSearchParams({ source: appKey, stage });
  if (existing?.resumeConnectionId) params.set("resume", existing.resumeConnectionId);
  if (existing?.reconnectConnectionId) params.set("reconnect", existing.reconnectConnectionId);
  if (existing?.interactionId) params.set("intent", existing.interactionId);
  const path = credentialSource === "vercel_connect" ? "/apps/vercel-connect" : "/apps/connect";
  return `${path}?${params.toString()}`;
}

function withConnectionIntent(href: string, interactionId?: string | null): string {
  if (!interactionId) return href;
  const [path, query = ""] = href.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("intent", interactionId);
  return `${path}?${params.toString()}`;
}

type AppAccessSelection = "all_agents" | { agentIds: string[] };

// Access comes before credentials so the reader knows what identity and reach
// the secret is about to get before they share it (PAP-17835).
const STEP_LABELS = [t("localizationConnections.pickApp4"), t("localizationConnections.access5"), t("localizationConnections.addYourKey6")];
const STEP_INDEX: Record<Exclude<Step, "success">, number> = {
  gallery: 0,
  access: 1,
  key: 2,
};
const SELECTED_APP_STEP_INDEX: Record<Exclude<Step, "gallery" | "success">, number> = {
  access: 0,
  key: 1,
};
const ZAPIER_STEP_LABELS = [t("localizationConnections.access5"), t("localizationConnections.addMCPURL7")];

/**
 * Which identity a fresh connection should default to (PAP-17835).
 *
 * Company identity is the product default whenever the selected method permits
 * it. Personal-only methods still stay personal, and reconnects preserve their
 * original identity through the explicit reconnect hint.
 */
function defaultGrantKindFor(method: ConnectionMethodDef | null): ConnectionGrantKind {
  if (method?.grantKinds?.length === 1) return method.grantKinds[0]!;
  if (method?.grantKinds && !method.grantKinds.includes("organization")) return method.grantKinds[0]!;
  return "organization";
}

function configuredAgentIdentity(connection: ToolConnection): string | undefined {
  const oauth = connection.config?.oauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
  const value = (oauth as Record<string, unknown>).connectorSubjectAgentId;
  return typeof value === "string" ? value : undefined;
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
  // still ask the operator to choose unless only one is available. A method
  // that supports an agent-owned identity must also be selected before the
  // Access step: that ownership decision cannot be represented by a legacy
  // compatibility method such as GitHub's advanced PAT option.
  return methods.length === 1 || recommended?.capabilityProfile || recommended?.grantKinds?.includes("agent")
    ? recommended
    : null;
}

function recommendedManagedConnectorMethod(
  entry: AppDefinition | null | undefined,
): ConnectionMethodDef | null {
  return recommendedSetupConnectionMethod(
    (entry?.methods ?? []).filter((candidate) =>
      candidate.oauthStrategy === "paperclip_cloud_connector"
      || candidate.oauthStrategy === "paperclip_id_connector",
    ),
  );
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
  const { t } = useTranslation();
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
  const connectionIntentId = interactionId?.trim()
    || searchParams.get("intent")?.trim()
    || null;
  const appKey = routeParams.appKey ?? searchParams.get("appKey") ?? undefined;
  const sourceSlug = searchParams.get("source")?.trim() || null;
  const createNewConnection = searchParams.get("new") === "1";
  const routeStage = searchParams.get("stage")?.trim() || null;
  const resumeConnectionId = searchParams.get("resume")?.trim() || null;
  const oauthCallbackOutcome = searchParams.get("oauth");
  const oauthCallbackCode = searchParams.get("code");
  const githubInstallationUrl = githubRecoveryUrl(searchParams.get("installation_url"));
  const githubManagementUrl = githubRecoveryUrl(searchParams.get("management_url"));
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
  const [restoredEnrollmentAccess] = useState<EnrollmentAccessState | null>(() =>
    host === "page"
      && searchParams.get("cloud_connector") === "enrolled"
      && requestedAppKey
      ? consumeEnrollmentAccessState(requestedAppKey)
      : null,
  );

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

  const [step, setStep] = useState<Step>(() => requestedConnectionInitialStep({
    requestedAppKey,
    routeStage,
    resumeConnectionId,
    hasPrefilledLink: Boolean(prefill.link),
    zapierSource,
  }));
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
    () => new Set(restoredEnrollmentAccess?.agentIds ?? (requestedAgentId ? [requestedAgentId] : [])),
  );
  /**
   * Access-step selections (PAP-17835). These are chosen before the credential
   * and committed with it, so they must survive a failed submit and a trip
   * backwards through the wizard.
   */
  const [grantKind, setGrantKind] = useState<ConnectionGrantKind>(
    restoredEnrollmentAccess?.grantKind ?? reconnectGrantKindHint ?? "organization",
  );
  const [installChoice, setInstallChoice] = useState<"specific" | "all">(
    restoredEnrollmentAccess?.installChoice ?? (requestedAgentId ? "specific" : "all"),
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
    return oauthCallbackErrorMessage(oauthCallbackOutcome, oauthCallbackCode);
  });
  /** Host of the page the operator is about to be sent to, shown while redirecting. */
  const [authorizationHost, setAuthorizationHost] = useState<string | null>(null);
  const directOAuthAccessConfirmedRef = useRef(false);
  const directOAuthRetryingRef = useRef(false);
  const hydratedResumeConnectionIdRef = useRef<string | null>(null);
  const [hydratedResumeConnectionId, setHydratedResumeConnectionId] = useState<string | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);
  const oauthHandoffAbortRef = useRef<AbortController | null>(null);
  const [showConnectionChoice, setShowConnectionChoice] = useState(
    existingConnections.length > 0 && Boolean(onUseExisting),
  );
  const [existingConnectionPendingId, setExistingConnectionPendingId] = useState<string | null>(null);
  const [existingConnectionError, setExistingConnectionError] = useState<string | null>(null);
  const [unavailableReconnectId, setUnavailableReconnectId] = useState<string | null>(null);

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
      setOAuthError(t("localizationConnections.paperclipCouldnTOpenTheSignInWindowAllowPopup11"));
      onPhaseChange?.("needs_retry");
      return;
    }
    popup.location.assign(url);
    popup.focus();
  }, [host, onPhaseChange, t]);

  const prepareAndOpenOAuth = useCallback(async (
    start: Pick<ToolOAuthStartResult, "authorizationUrl" | "handoff">,
  ) => {
    oauthHandoffAbortRef.current?.abort();
    const controller = new AbortController();
    oauthHandoffAbortRef.current = controller;
    try {
      const target = await prepareOAuthNavigation(start, { signal: controller.signal });
      if (target.kind === "reauthentication") {
        const destination = host === "dialog" ? oauthPopupRef.current : window;
        if (!destination || destination.closed || !start.handoff) {
          throw new Error(t("localizationConnections.paperclipCouldnTPreserveThisSignInWhileRefres13"));
        }
        savePendingCloudHandoff(start.handoff.session, destination.sessionStorage);
        setOAuthPhase("starting");
      } else {
        setAuthorizationHost(target.host);
        setOAuthPhase("redirecting");
      }
      openAuthorization(target.url);
    } catch (error) {
      if (controller.signal.aborted) return;
      setOAuthPhase("error");
      setOAuthError(error instanceof Error ? error.message : t("localizationConnections.paperclipCouldnTStartSecureSignInTryAgain14"));
      onPhaseChange?.("needs_retry");
    } finally {
      if (oauthHandoffAbortRef.current === controller) oauthHandoffAbortRef.current = null;
    }
  }, [host, onPhaseChange, openAuthorization, t]);

  useEffect(() => () => oauthHandoffAbortRef.current?.abort(), []);

  useEffect(() => {
    if (host !== "dialog" || !connectionIntentId) return;
    const receiveOAuthOutcome = (event: MessageEvent) => {
      const outcome = readConnectionIntentOAuthOutcome(event, window.location.origin, connectionIntentId);
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
      setOAuthError(t("localizationConnections.authorizationDidNotCompleteTryAgainWhenYouReR15"));
    };
    window.addEventListener("message", receiveOAuthOutcome);
    return () => window.removeEventListener("message", receiveOAuthOutcome);
  }, [connectionIntentId, host, onComplete, onOAuthDeclined, t]);

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
      setStep("access");
      navigate(withConnectionIntent("/apps/connect?source=zapier", connectionIntentId));
      return;
    }
    if (credentialSource === "paperclip_vault" && canUseAutomaticOAuthFastPath(picked)) {
      navigate(appSourceConnectHref(picked.slug, connectionIntentId));
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
        ? withConnectionIntent(vercelConnectSourceHref(picked.slug), connectionIntentId)
        : appSourceConnectHref(picked.slug, connectionIntentId),
    );
  };

  const backToGallery = () => {
    // Back is a wizard transition, so keep the selected app and entered draft
    // intact. Picking another connector will replace that state explicitly.
    setStep("gallery");
    navigate(withConnectionIntent(
      credentialSource === "vercel_connect"
        ? vercelConnectSourceHref()
        : byoOnly ? "/apps/byo" : "/apps",
      connectionIntentId,
    ));
  };

  useEffect(() => {
    if (host !== "page") return;
    setBreadcrumbs([
      { label: t("localizationConnections.connectors16"), href: "/apps" },
      { label: vercelConnectMode ? "Vercel Connect" : byoOnly ? t("localizationConnections.connectYourOwnTool18") : t("localizationConnections.connectAnApp19") },
    ]);
    return () => setBreadcrumbs([]);
  }, [byoOnly, host, setBreadcrumbs, vercelConnectMode, t]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const fullRequestedDefinition = requestedAppKey
    ? getConnectableAppDefinition(requestedAppKey)
    : null;
  const requestedDefinitionUsesManagedConnector = Boolean(
    fullRequestedDefinition?.methods.some((candidate) =>
      candidate.oauthStrategy === "paperclip_cloud_connector"
      || candidate.oauthStrategy === "paperclip_id_connector"
    ),
  );
  const entryAdvertisesManagedConnector = Boolean(
    entry?.methods.some((candidate) =>
      candidate.oauthStrategy === "paperclip_cloud_connector"
      || candidate.oauthStrategy === "paperclip_id_connector"
    ),
  );
  // Before a self-hosted instance enrolls, the server intentionally withholds
  // platform-managed methods from the advertised gallery. The setup route still
  // needs the managed method's identity model, labels, and defaults because the
  // next step is enrollment for that exact method—not the visible PAT/BYO
  // compatibility fallback.
  const preEnrollmentManagedMethod = entry
    && requestedDefinitionUsesManagedConnector
    && !entryAdvertisesManagedConnector
    ? recommendedManagedConnectorMethod(fullRequestedDefinition)
    : null;
  const connectorEnrollmentQuery = useQuery({
    queryKey: ["cloud-connector", "enrollment"],
    queryFn: () => toolsApi.getCloudConnectorEnrollment(),
    enabled: Boolean(
      selectedCompanyId
      && requestedDefinitionUsesManagedConnector
      && !entryAdvertisesManagedConnector
    ),
  });
  const [connectorEnrollmentError, setConnectorEnrollmentError] = useState<string | null>(null);
  const preserveEnrollmentAccess = useCallback(() => {
    if (!selectedCompanyId || !requestedAppKey) return;
    saveEnrollmentAccessState(selectedCompanyId, requestedAppKey, {
      grantKind,
      installChoice,
      agentIds: installChoice === "specific" ? [...installAgentIds] : [],
    });
  }, [grantKind, installAgentIds, installChoice, requestedAppKey, selectedCompanyId]);
  const openConnectorEnrollment = useCallback((verificationUrl: string) => {
    const target = resolveAuthorizationTarget(verificationUrl);
    if (!target.ok) {
      setConnectorEnrollmentError(target.message);
      return;
    }
    navigateTopLevel(target.url);
  }, []);
  const startConnectorEnrollment = useMutation({
    mutationFn: () => toolsApi.startCloudConnectorEnrollment(
      selectedCompanyId!,
      selectedCompany?.name,
      requestedAppKey
        ? appConnectHref(requestedAppKey, "key", credentialSource, {
            resumeConnectionId,
            reconnectConnectionId,
            interactionId: connectionIntentId,
          })
        : undefined,
    ),
    onSuccess: (status) => {
      if (!status.verificationUrl) {
        setConnectorEnrollmentError(t("localizationConnections.paperclipCloudDidNotReturnAnEnrollmentLinkTry20"));
        return;
      }
      openConnectorEnrollment(status.verificationUrl);
    },
    onError: (error) => {
      setConnectorEnrollmentError(
        error instanceof Error ? error.message : t("localizationConnections.paperclipCouldnTReachPaperclipCloudTryAgain21"),
      );
    },
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
  const reconnectSourceMatches = retainedReconnectMatches({
    requestedAppKey,
    byo,
    applicationId: prefill.applicationId,
    reconnectConnection,
    reconnectApplication,
  });
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
      : identityConnection.credentialPolicy === "per_agent"
        ? "agent"
      : "organization"
    : reconnectGrantKindHint;
  const resumableOAuthConnection = resumeConnection?.authKind === "oauth"
    ? resumeConnection
    : existingOAuthConnection;
  const existingOAuthGrantKind: ConnectionGrantKind | null = existingOAuthConnection
    ? existingOAuthConnection.credentialPolicy === "per_user"
      ? "user"
      : existingOAuthConnection.credentialPolicy === "per_agent"
        ? "agent"
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
        interactionId: connectionIntentId,
      }));
    }
  };

  const oauthStartMutation = useMutation({
    // Retry/reconnect reads identity from the durable connection. Provider is
    // not identity: an organization Notion connection must stay organization-
    // scoped, while a personal one must put its token back on that user grant.
    mutationFn: (connection: ToolConnection) => toolsApi.startOAuth(connection.id, {
      asCurrentUser: connection.credentialPolicy === "per_user",
      ...(connection.credentialPolicy === "per_agent"
        ? { asAgentId: configuredAgentIdentity(connection) ?? [...installAgentIds][0] }
        : {}),
      ...(connectionIntentId ? { interactionId: connectionIntentId } : {}),
    }),
    onSuccess: (start) => void prepareAndOpenOAuth(start),
    onError: (error) => {
      const details = error instanceof ApiError && error.body && typeof error.body === "object"
        ? (error.body as { details?: { code?: unknown } }).details
        : null;
      setOAuthPhase("error");
      onPhaseChange?.("needs_retry");
      setOAuthError(
        details?.code === "invalid_grant"
          ? t("localizationConnections.yourAuthorizationExpiredOrWasRevokedReconnect22")
          : error instanceof Error
            ? error.message
            : t("localizationConnections.paperclipCouldnTStartSecureSignInTryAgain14"),
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
    const dedicatedIdentity = (fixedGrantKind ?? grantKind) === "agent";
    const installState = !dedicatedIdentity && installChoice === "all"
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
          ...(requestedGrantKind !== "organization" ? { grantKind: requestedGrantKind } : {}),
          ...(requestedGrantKind === "agent" ? { subjectAgentId: [...installAgentIds][0] } : {}),
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
          genericPayload.name ?? defaultGenericMcpName(linkUrl) ?? t("localizationConnections.customApp23"),
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
          ...(effectiveGrantKind !== "organization" ? { grantKind: effectiveGrantKind } : {}),
          ...(effectiveGrantKind === "agent" ? { subjectAgentId: [...installAgentIds][0] } : {}),
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
        setGenericOAuthPending(true);
        void prepareAndOpenOAuth({
          authorizationUrl: startUrl,
          handoff: result.auth.handoff,
        });
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
            ? t("localizationConnections.yourAuthorizationExpiredOrWasRevokedReconnect22")
            : error instanceof Error
              ? error.message
              : t("localizationConnections.paperclipCouldnTStartSecureSignInTryAgain14"),
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
        title: t("localizationConnections.couldnTConnect24"),
        body: error instanceof Error ? error.message : t("localizationConnections.pleaseCheckYourKeyAndTryAgain25"),
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
    const requestedEntryAdvertisesManagedConnector = Boolean(
      requestedEntry?.methods.some((candidate) =>
        candidate.oauthStrategy === "paperclip_cloud_connector"
        || candidate.oauthStrategy === "paperclip_id_connector"
      ),
    );
    // The enrollment lookup decides whether a hidden managed method means
    // "enroll this instance" or "that Cloud profile is unavailable here".
    // Do not choose a method until that distinction is known: retaining the
    // hidden method key after an active enrollment produces an empty setup
    // screen with a permanently disabled generic Connect button.
    if (
      requestedDefinitionUsesManagedConnector
      && !requestedEntryAdvertisesManagedConnector
      && connectorEnrollmentQuery.isLoading
    ) return;
    const methods = connectionMethodsForCredentialSource(requestedEntry, credentialSource);
    const initialMethod = (
      requestedDefinitionUsesManagedConnector
        && !requestedEntryAdvertisesManagedConnector
        && connectorEnrollmentQuery.data?.configured !== true
        ? recommendedManagedConnectorMethod(fullRequestedDefinition)
        : null
    ) ?? recommendedSetupConnectionMethod(methods);
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
    const definitionUnavailable = isConnectionDefinitionUnavailable({
      available: requestedEntry?.availability?.available,
      reconnectConnectionId,
      reconnectSourceMatches,
    });
    const setupResolution = requestedConnectionSetupResolution({
      reconnectConnectionId,
      hasRequestedEntry: Boolean(requestedEntry),
      supportedMethodCount: methods.length,
      unsupportedOAuth,
      vercelUnavailable,
      definitionUnavailable,
    });
    if (setupResolution !== "ready") {
      setEntry(null);
      setStep("gallery");
      if (setupResolution === "reconnect_unavailable" && reconnectConnectionId) {
        setUnavailableReconnectId(reconnectConnectionId);
        return;
      }
      navigate(withConnectionIntent(
        credentialSource === "vercel_connect" ? vercelConnectSourceHref() : "/apps/connect",
        connectionIntentId,
      ), { replace: true });
      return;
    }
    setUnavailableReconnectId(null);
    if (!requestedEntry) return;

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
      setConnectionMethodKey(initialMethod?.key ?? "");
      setConfigValues(defaultMethodConfig(initialMethod));
      setGoogleSheetsLinks("");
      setGoogleSheetsError(null);
      setConnectResult(null);
      const matchingEnrollmentAccess = restoredEnrollmentAccess?.companyId === selectedCompanyId
        ? restoredEnrollmentAccess
        : null;
      setGrantKind(reconnectGrantKind ?? matchingEnrollmentAccess?.grantKind ?? defaultGrantKindFor(initialMethod));
      setInstallAgentIds(new Set(
        matchingEnrollmentAccess?.agentIds ?? (requestedAgentId ? [requestedAgentId] : []),
      ));
      setInstallChoice(matchingEnrollmentAccess?.installChoice ?? (requestedAgentId ? "specific" : "all"));
      // Route/service selection initializes the wizard once. Later renders must
      // preserve the user's current step in both hosts instead of snapping back
      // to Access after they continue.
      setStep(requestedConnectionInitialStep({
        requestedAppKey,
        routeStage,
        resumeConnectionId,
        hasPrefilledLink: Boolean(prefill.link),
        zapierSource,
      }));
    } else if (
      connectorEnrollmentQuery.data?.configured === true
      && connectionMethodKey
      && !methods.some((candidate) => candidate.key === connectionMethodKey)
    ) {
      // A failed enrollment lookup can select the hidden pre-enrollment
      // method. Replace it after a successful refetch proves that the instance
      // is enrolled and the current Cloud gallery does not advertise it.
      setConnectionMethodKey(initialMethod?.key ?? "");
      setConfigValues(defaultMethodConfig(initialMethod));
    }

    if (automaticOAuth && (
      !applicationsQuery.isFetchedAfterMount ||
      !connectionsQuery.isFetchedAfterMount
    )) return;
    if (automaticOAuth && directOAuthRetryingRef.current) return;
    if (automaticOAuth && (applicationsQuery.isError || connectionsQuery.isError)) {
      setOAuthPhase("error");
      setOAuthError(t("localizationConnections.paperclipCouldnTCheckForAnExistingConnectionT26"));
      setStep("key");
      return;
    }
  }, [
    applicationsQuery.isError,
    applicationsQuery.isFetchedAfterMount,
    applicationsQuery.data,
    connectionsQuery.isError,
    connectionsQuery.isFetchedAfterMount,
    connectorEnrollmentQuery.data?.configured,
    connectorEnrollmentQuery.isLoading,
    connectionMethodKey,
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
    fullRequestedDefinition,
    requestedAppKey,
    requestedAgentId,
    restoredEnrollmentAccess,
    routeStage,
    zapierSource,
  t]);

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
      setOAuthError(oauthCallbackErrorMessage(oauthCallbackOutcome, oauthCallbackCode));
    } else {
      setOAuthPhase("entry");
      setOAuthError(null);
    }
    setStep("key");
    hydratedResumeConnectionIdRef.current = resumeConnection.id;
    setHydratedResumeConnectionId(resumeConnection.id);
  }, [credentialSource, entry, oauthCallbackCode, oauthCallbackOutcome, resumeConnection]);

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
        title: t("localizationConnections.couldnTFinishSetup27"),
        body: error instanceof Error ? error.message : t("localizationConnections.pleaseTryAgain28"),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{t("localizationConnections.selectACompanyToConnectApps29")}</div>;
  }

  if (
    (resumeConnectionId || reconnectConnectionId)
    && (connectionsQuery.isError || applicationsQuery.isError)
  ) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">{t("localizationConnections.couldnTLoadConnectionSetup30")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("localizationConnections.paperclipCouldnTCheckTheRetainedConnectionThe31")}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={async () => {
              const [connectionsResult, applicationsResult] = await Promise.all([
                connectionsQuery.refetch(),
                applicationsQuery.refetch(),
              ]);
              if (!connectionsResult.isError && !applicationsResult.isError) {
                setOAuthError(null);
                setOAuthPhase("entry");
              }
            }}
          >{t("localizationConnections.tryAgain32")}</Button>
          <Button type="button" variant="outline" onClick={() => navigate("/apps")}>{t("pages.apps.common.backToApps")}</Button>
        </div>
      </div>
    );
  }

  if (resumeConnectionId && connectionsQuery.isFetchedAfterMount && !resumeConnection) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">{t("localizationConnections.thisSetupCanTBeResumed33")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("localizationConnections.theSavedConnectionNoLongerExistsOrIsNotAvaila34")}</p>
        <Button type="button" variant="outline" className="mt-5" onClick={() => navigate("/apps")}>{t("pages.apps.common.backToApps")}</Button>
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
        <h2 className="text-lg font-semibold text-foreground">{t("localizationConnections.thisConnectionCanTBeReconnected35")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {!reconnectConnection
            ? t("localizationConnections.theRetainedConnectionNoLongerExistsOrIsNotAva36")
            : t("localizationConnections.thisReconnectLinkDoesNotMatchTheRetainedConne37")}
        </p>
        <Button type="button" variant="outline" className="mt-5" onClick={() => navigate("/apps")}>{t("pages.apps.common.backToApps")}</Button>
      </div>
    );
  }

  if ((resumeConnectionId || reconnectConnectionId) && galleryQuery.isError) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">{t("localizationConnections.couldnTLoadConnectionSetup30")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("localizationConnections.paperclipCouldnTLoadTheProviderDetailsNeededT38")}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="button" onClick={() => void galleryQuery.refetch()}>{t("localizationConnections.tryAgain32")}</Button>
          <Button type="button" variant="outline" onClick={() => navigate("/apps")}>{t("pages.apps.common.backToApps")}</Button>
        </div>
      </div>
    );
  }

  if (reconnectConnectionId && unavailableReconnectId === reconnectConnectionId) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">{t("localizationConnections.thisConnectionCanTBeReconnected35")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("localizationConnections.paperclipNoLongerHasASupportedSetupMethodForT39")}</p>
        <Button type="button" variant="outline" className="mt-5" onClick={() => navigate("/apps")}>{t("pages.apps.common.backToApps")}</Button>
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
      <div className="mx-auto max-w-xl space-y-4" aria-label={t("localizationConnections.loadingSavedConnectionSetup40")}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (reconnectConnectionId && (
    !connectionsQuery.isFetchedAfterMount
    || !applicationsQuery.isFetchedAfterMount
    || galleryQuery.isLoading
    || Boolean(requestedAppKey && !entry)
  )) {
    return (
      <div className="mx-auto max-w-xl space-y-4" aria-label={t("localizationConnections.loadingRetainedConnectionSetup41")}>
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
            {requestedAppKey ? t("localizationConnections.reuseConnection") : t("localizationConnections.reuseAppConnection")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("localizationConnections.reuseAConnectionWithoutChangingWhoAlreadyHasA44")}</p>
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
                  setExistingConnectionError(error instanceof Error ? error.message : t("localizationConnections.couldnTUseThisConnection45"));
                  setExistingConnectionPendingId(null);
                }
              }}
            >
              <span>
                <span className="block font-medium text-foreground">{connection.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {connection.status === "active" && connection.enabled ? t("localizationConnections.readyToUse46") : t("localizationConnections.setupNeedsAttention47")}
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
          <Button type="button" variant="outline" onClick={() => setShowConnectionChoice(false)}>{t("localizationConnections.connectNew48")}</Button>
          {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>{t("localizationConnections.cancel49")}</Button> : null}
        </div>
      </div>
    );
  }

  const showCuratedOAuthState = Boolean(
    automaticOAuthEntry
    && step === "key"
    && (directOAuthEntry || oauthPhase !== "entry"),
  );

  const showConnectorEnrollmentStep = Boolean(
    step === "key"
    && entry
    && requestedDefinitionUsesManagedConnector
    && !entryAdvertisesManagedConnector
    && (
      connectorEnrollmentQuery.isLoading
      || connectorEnrollmentQuery.isError
      || connectorEnrollmentQuery.data?.configured !== true
    )
  );

  if (showCuratedOAuthState && automaticOAuthEntry) {
    return (
      <OAuthConnectStateScreen
        entry={automaticOAuthEntry}
        resuming={Boolean(resumeConnectionId)}
        phase={oauthPhase}
        error={oauthError}
        recoveryActions={oauthCallbackCode === "github_installation_required" ? {
          installationUrl: githubInstallationUrl,
          managementUrl: githubManagementUrl,
        } : undefined}
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
              setOAuthError(t("localizationConnections.paperclipCouldnTCheckForAnExistingConnectionT26"));
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
                setGrantKind(
                  refreshedConnection.credentialPolicy === "per_user"
                    ? "user"
                    : refreshedConnection.credentialPolicy === "per_agent"
                      ? "agent"
                      : "organization",
                );
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
        onBack={() => {
          oauthHandoffAbortRef.current?.abort();
          setOAuthPhase("entry");
          setOAuthError(null);
          setAppStep("access");
        }}
        onCancel={() => {
          oauthHandoffAbortRef.current?.abort();
          (onCancel ?? (() => navigate("/apps")))();
        }}
      />
    );
  }

  // A pasted endpoint that needs browser sign-in gets the same waiting/retry
  // screen a curated OAuth app does, minus the branding it doesn't have.
  if (genericOAuthPending && !entry && linkUrl && step === "key") {
    return (
      <OAuthConnectStateScreen
        identity={{
          name: linkName.trim() || endpointHost(linkUrl) || t("localizationConnections.thisServer50"),
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
        onBack={() => {
          oauthHandoffAbortRef.current?.abort();
          setGenericOAuthPending(false);
          setOAuthPhase("entry");
          setOAuthError(null);
        }}
        onCancel={() => {
          oauthHandoffAbortRef.current?.abort();
          (onCancel ?? (() => navigate("/apps")))();
        }}
      />
    );
  }

  const appName =
    connectResult?.application.name ??
    entry?.name ??
    (linkName.trim() || defaultGenericMcpName(linkUrl) || t("localizationConnections.thisApp51"));
  const credentialSourceMethods = connectionMethodsForCredentialSource(entry, credentialSource);
  const setupCredentialSourceMethods = preEnrollmentManagedMethod
    ? [preEnrollmentManagedMethod]
    : credentialSourceMethods;
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
    : entry && setupCredentialSourceMethods.length > 1
      ? [t("localizationConnections.access5"), t("localizationConnections.chooseConnection52")]
    : entry && setupCredentialSourceMethods[0]?.auth === "oauth"
      ? [t("localizationConnections.access5"), t("localizationConnections.signIn53")]
    : isGoogleSheetsRobotMethod(entry, connectionMethodKey)
      ? [t("localizationConnections.access5"), t("localizationConnections.shareSheet54")]
      : entry
        ? [t("localizationConnections.access5"), t("localizationConnections.addYourKey6")]
      : STEP_LABELS;
  // The Access step's identity question only makes sense when there *is* a
  // credential, so it reads the selected method's auth kind.
  const accessStepMethod = entry
    ? (connectionMethodKey
        ? setupCredentialSourceMethods.find((m) => m.key === connectionMethodKey) ?? null
        : setupCredentialSourceMethods[0] ?? null)
    : null;
  const accessStepAuthKind: ToolConnectionAuthKind = entry
    ? accessStepMethod?.auth ?? "none"
    : linkAuthMode === "none"
      ? "none"
      : linkAuthMode === "oauth"
        ? "oauth"
        : "api_key";
  // Name the actual next effect: multi-method apps and enrollment still have
  // a local setup screen, even when OAuth is already the selected method.
  const accessContinuesToProvider = Boolean(directOAuthEntry);
  const accessSubmitLabel = accessContinuesToProvider
    ? entry ? t("localizationConnections.continueApp", { app: entry.name }) : t("localizationConnections.continueToSignInFallback")
    : accessStepAuthKind === "oauth" ? t("localizationConnections.continue64") : t("localizationConnections.saveAndContinue56");

  const stepIndex = (zapierSource || entry) && step !== "gallery" && step !== "success"
    ? SELECTED_APP_STEP_INDEX[step]
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
                  ? t("localizationConnections.chooseAReviewedAppToConnectThroughVercel57")
                  : t("pages.apps.connect.pickAppSubtitle")
                : t("localizationConnections.step", { current: stepIndex + 1, total: stepLabels.length })
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
            setStep("access");
          }}
        />
      )}

      {step === "key" && entry && showConnectorEnrollmentStep ? (
        <div className="mx-auto max-w-xl">
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-muted p-2 text-muted-foreground">
                <Cloud className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-foreground">{t("localizationConnections.connectWithPaperclip59")}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("localizationConnections.cloudEnrollmentRequired", { app: entry.name })}
                </p>
              </div>
            </div>

            {connectorEnrollmentQuery.isError || connectorEnrollmentError ? (
              <InlineBanner tone="danger" className="mt-4">
                {connectorEnrollmentError ?? t("localizationConnections.paperclipCouldnTCheckCloudRegistrationTryAgai62")}
              </InlineBanner>
            ) : null}

            <div className="mt-6 flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setAppStep("access")}>{t("localizationConnections.back63")}</Button>
              <Button
                type="button"
                disabled={connectorEnrollmentQuery.isLoading || startConnectorEnrollment.isPending}
                onClick={() => {
                  setConnectorEnrollmentError(null);
                  preserveEnrollmentAccess();
                  // Let the server reuse a live enrollment or replace an expired
                  // one. A cached verification URL may expire while this page is open.
                  startConnectorEnrollment.mutate();
                }}
              >
                {startConnectorEnrollment.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {connectorEnrollmentQuery.data?.status === "pending"
                  ? t("localizationConnections.continue64")
                  : t("localizationConnections.connectWithPaperclip59")}
              </Button>
            </div>
          </div>
        </div>
      ) : step === "key" && entry ? (
        <KeyStep
          entry={entry}
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
          // Back returns to Access for new, resumed, and reconnected accounts.
          // Cancel is the separate exit to the connector list.
          onBack={() => setAppStep("access")}
          onConnect={() => {
            if (isGoogleSheetsRobotMethod(entry, connectionMethodKey)) {
              const parsed = parseGoogleSheetIds(googleSheetsLinks);
              if (parsed.invalidCount > 0) {
                setGoogleSheetsError(t("localizationConnections.thatDoesnTLookLikeAGoogleSheetsLink65"));
                return;
              }
              if (parsed.ids.length === 0) {
                setGoogleSheetsError(t("localizationConnections.pasteAtLeastOneGoogleSheetsLink66"));
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
      ) : null}

      {step === "key" && !entry && linkUrl && !zapierSource && (
        <LinkConnectStep
          link={linkUrl}
          name={linkName}
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
          onBack={() => setStep("access")}
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
          onBack={() => setStep("access")}
          onConnect={() => connectMutation.mutate(undefined)}
        />
      )}

      {step === "access" && (
        <AccessStep
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
          githubIdentity={entry?.slug === "github"}
          submitLabel={accessSubmitLabel}
          continuesToProvider={accessContinuesToProvider}
          identityLoading={Boolean(automaticOAuthEntry) && directOAuthLookupPending}
          preserveAgentAccess={Boolean(automaticOAuthEntry && (resumableOAuthConnection || reconnectConnection))}
          pending={connectMutation.isPending || oauthStartMutation.isPending}
          onBack={backToGallery}
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
          onDone={onCancel ?? (() => navigate("/apps"))}
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
  const { t } = useTranslation();
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {appIdentity ? (
            <AppLogo name={appIdentity.name} logoUrl={appIdentity.logoUrl} darkLogoUrl={appIdentity.darkLogoUrl} size={44} />
          ) : null}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {appIdentity ? t("localizationConnections.connectApp", { app: appIdentity.name }) : t("pages.apps.connect.gallery.connectOwnServer")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            {unverifiedHost ? <UnverifiedServerBadge host={unverifiedHost} className="mt-2" /> : null}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t("localizationConnections.cancel49")}</Button>
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
  recoveryActions,
  authorizationHost,
  onRetry,
  onBack,
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
  recoveryActions?: { installationUrl: string | null; managementUrl: string | null };
  /**
   * Host of the authorization page being opened. A valid HTTPS authorization
   * page can still be a phishing page, so the operator sees exactly which host
   * they are being handed to (PAP-17099).
   */
  authorizationHost?: string | null;
  onRetry: () => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const serverName = entry?.name ?? identity?.name ?? t("localizationConnections.thisServer50");
  const unverifiedHost = entry ? null : identity?.unverifiedHost ?? null;
  const status = phase === "entry"
    ? {
        title: resuming
          ? t("localizationConnections.finishConnecting", { server: serverName })
          : t("localizationConnections.connectServer", { server: serverName }),
        body: resuming
          ? t("localizationConnections.savedConnection", { server: serverName })
          : t("localizationConnections.openServer", { server: serverName }),
      }
    : phase === "starting"
      ? {
          title: t("localizationConnections.preparingSecureSignIn73"),
          body: t("localizationConnections.preparingConnection", { server: serverName }),
        }
      : phase === "redirecting"
        ? {
            title: t("localizationConnections.openingServer", { server: serverName }),
            body: authorizationHost
              ? t("localizationConnections.verifyAuthorizationHost", { host: authorizationHost })
              : t("localizationConnections.continueServer", { server: serverName }),
          }
        : {
            title: t("localizationConnections.serverFailed", { server: serverName }),
            body: error ?? t("localizationConnections.paperclipCouldnTStartSecureSignInTryAgain14"),
          };

  return (
    <div className="max-w-5xl">
      <StepHeader
        subtitle={t("pages.apps.connect.oauth.subtitle")}
        step="key"
        activeIndex={1}
        labels={[t("localizationConnections.access5"), t("localizationConnections.signIn53"), t("localizationConnections.ready79")]}
        appIdentity={entry ? { name: entry.name, logoUrl: entry.branding.logoUrl, darkLogoUrl: entry.branding.darkLogoUrl } : undefined}
        unverifiedHost={unverifiedHost}
        onCancel={onCancel}
      />
      <div className="mx-auto max-w-xl">
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

        {phase === "error" && recoveryActions && (recoveryActions.installationUrl || recoveryActions.managementUrl) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {recoveryActions.installationUrl ? (
              <Button type="button" variant="outline" asChild>
                <a href={recoveryActions.installationUrl} target="_blank" rel="noreferrer">{t("localizationConnections.installPaperclipOnGitHub80")}<ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
            ) : null}
            {recoveryActions.managementUrl ? (
              <Button type="button" variant="ghost" asChild>
                <a href={recoveryActions.managementUrl} target="_blank" rel="noreferrer">{t("localizationConnections.manageRepositoriesOnGitHub81")}</a>
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex items-center gap-2">
          {phase === "error" || phase === "entry" ? (
            <Button type="button" onClick={onRetry}>
              {phase === "entry"
                ? resuming ? t("localizationConnections.finishWith", { server: serverName }) : t("localizationConnections.continueTo", { server: serverName })
                : t("localizationConnections.tryAgain32")}
            </Button>
          ) : (
            <Button type="button" disabled>
              {phase === "redirecting" ? t("localizationConnections.openingServerEllipsis", { server: serverName }) : t("pages.apps.connect.oauth.preparing")}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onBack}>{t("localizationConnections.back63")}</Button>
        </div>
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
  const { t } = useTranslation();
  const normalizedLink = normalizeAppLink(link);
  const zapierHostname = normalizedLink ? new URL(normalizedLink).hostname : "";
  const isZapierLink = zapierHostname === "zapier.com" || zapierHostname.endsWith(".zapier.com");

  return (
    <div className="mx-auto max-w-xl">
      <div>
        <label className="text-sm font-medium text-foreground">{t("pages.apps.connect.zapier.urlLabel")}</label>
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
        {link.trim() && !isZapierLink && (
          <p className="mt-2 text-xs text-destructive">{t("pages.apps.connect.zapier.invalidUrl")}</p>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>{t("localizationConnections.back63")}</Button>
        <Button onClick={onConnect} disabled={submitting || !isZapierLink}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitting ? t("pages.apps.connect.checking") : t("pages.apps.connect.checkLink")}
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
}: {
  loading: boolean;
  apps: AppDefinition[];
  /** Entered via the "Connect your own MCP server" card (PAP-12371, Finding C): focus the link path. */
  byo?: boolean;
  /** Canonical BYO page: keep the focused URL setup without the app gallery. */
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
}) {
  const { t } = useTranslation();
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
      setLinkError(t("localizationConnections.pasteAFullHttpOrHttpsLink86"));
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
              <h2 className="text-lg font-bold tracking-tight">{t("localizationConnections.connectThroughVercel87")}</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("localizationConnections.createAndManageTheProviderConnectorInVercelPa88")}</p>
            </div>
            {vercelConnectAvailability ? (
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <a href={vercelConnectAvailability.manageUrl} target="_blank" rel="noreferrer">{t("localizationConnections.openVercelConnect89")}<ArrowUpRight className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            ) : null}
          </div>
          {vercelConnectAvailability?.available === false ? (
            <InlineBanner tone="danger" compact className="mt-4">
              {vercelConnectAvailability.reason ?? t("localizationConnections.vercelConnectIsUnavailableOnThisInstance90")}
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
              placeholder={t("pages.apps.browse.searchPlaceholder")}
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
                        {app.availability?.reason ?? vercelConnectAvailability?.reason ?? t("localizationConnections.unavailableOnThisInstance92")}
                      </span>
                    ) : oauthBlocked ? (
                      <span className="text-muted-foreground">{t("localizationConnections.unavailable93")}</span>
                    ) : (
                      <span>{t("pages.apps.browse.connectAction")}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">{t("localizationConnections.noAppsMatch", { query: search })}</div>
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
            {zapierSource ? t("pages.apps.connect.zapier.title") : byo ? t("pages.apps.connect.gallery.connectOwnServer") : t("pages.apps.connect.gallery.connectWithLink")}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {zapierSource
              ? t("pages.apps.connect.zapier.instructions")
              : byo
              ? t("localizationConnections.pasteYourMCPServerSURLAndEveryDiscoveredToolW96")
              : t("pages.apps.connect.gallery.linkInstructions")}
          </p>
          {!zapierSource && (
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans t={t} i18nKey="localizationConnections.remoteUrlHelp" components={{ code: <code className="rounded bg-muted px-1 py-0.5 text-xs" /> }} />
            </p>
          )}
          {matchedEntry && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <AppLogo name={matchedEntry.name} logoUrl={matchedEntry.branding.logoUrl} darkLogoUrl={matchedEntry.branding.darkLogoUrl} size={24} />
                <span className="truncate">{t("localizationConnections.looksLikeApp", { app: matchedEntry.name })}</span>
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
                  ? t("pages.apps.connect.gallery.notAvailable")
                  : matchedEntry.slug === "zapier"
                    ? t("localizationConnections.continue64")
                    : t("localizationConnections.useMatchedApp", { app: matchedEntry.name })}
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
              aria-label={t("localizationConnections.mCPServerURL101")}
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
            <Button type="button" variant="outline" onClick={continueWithLink}>{t("localizationConnections.continue64")}</Button>
          </div>
          {linkError && <div className="text-xs text-destructive">{linkError}</div>}
        </div>
      </div> : null}

    </div>
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
  const { t } = useTranslation();
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
  const displayedLink = matchedEntry?.slug === "zapier" ? redactUrlSecrets(link) : link;

  const updateHeader = (id: string, patch: Partial<CustomHeaderRow>) => {
    onHeadersChange(headers.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <div className="mx-auto max-w-xl">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate font-mono text-sm text-muted-foreground" title={displayedLink}>{displayedLink}</p>
        <UnverifiedServerBadge host={host} />
      </div>

      {matchedEntry && onUseMatchedEntry ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <AppLogo name={matchedEntry.name} logoUrl={matchedEntry.branding.logoUrl} darkLogoUrl={matchedEntry.branding.darkLogoUrl} size={24} />
            <span className="truncate">{t("localizationConnections.guidedSetupAvailable", { app: matchedEntry.name })}</span>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onUseMatchedEntry}>
            {t("localizationConnections.useMatchedApp", { app: matchedEntry.name })}
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

      <div className="mt-6 space-y-6">
        {showSimpleKeyQuestion && (
          <div>
            <label className="mr-2 text-sm font-medium text-foreground">{t("pages.apps.connect.needsKeyLabel")}</label>
            <div className="mt-2 inline-flex rounded-lg border border-border bg-muted/50 p-1">
              <SegmentedOption
                label={t("localizationConnections.no104")}
                selected={!needsKey}
                onClick={() => onNeedsKeyChange(false)}
              />
              <SegmentedOption
                label={t("localizationConnections.yes105")}
                selected={needsKey}
                onClick={() => onNeedsKeyChange(true)}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {needsKey
                ? t("pages.apps.connect.pasteKeyHint")
                : t("localizationConnections.mostServersJustWorkFromTheAddressPickYesOnlyI106")}
            </p>
          </div>
        )}

        {(showSimpleKeyQuestion && needsKey) || authMode === "bearer" ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-key">{t("pages.apps.connect.appKeyLabel")}</label>
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
          </div>
        ) : null}

        <Collapsible open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-left text-sm font-medium text-foreground hover:bg-accent/40">{t("localizationConnections.advancedAuthentication107")}<ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-5 pt-4">
            <p className="text-xs text-muted-foreground">{t("localizationConnections.onlyNeededWhenTheServerSDocsAreSpecificAboutH108")}</p>
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
                      placeholder={t("localizationConnections.headerName109")}
                      aria-label={t("localizationConnections.headerName109")}
                      className="h-10 font-mono"
                    />
                    <Input
                      type="password"
                      autoComplete="off"
                      value={row.value}
                      onChange={(e) => updateHeader(row.id, { value: e.target.value })}
                      placeholder={t("pages.secrets.fields.value")}
                      aria-label={row.name.trim() ? t("localizationConnections.headerValueFor", { name: row.name.trim() }) : t("localizationConnections.headerValue111")}
                      className="h-10 font-mono"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-10 shrink-0"
                      onClick={() => onHeadersChange(headers.filter((candidate) => candidate.id !== row.id))}
                      disabled={headers.length === 1}
                    >{t("localizationConnections.remove112")}</Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onHeadersChange([...headers, newCustomHeaderRow()])}
                >{t("localizationConnections.addAnotherHeader113")}</Button>
                {headerError ? <p className="text-xs text-destructive">{headerError}</p> : null}
              </div>
            ) : null}

            {authMode === "oauth" ? (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">{t("localizationConnections.paperclipSetsSignInUpOnItsOwnWheneverTheServe114")}</p>
                <div>
                  <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-client-id">{t("localizationConnections.clientID115")}</label>
                  <Input
                    id="generic-mcp-client-id"
                    value={oauthClientId}
                    onChange={(e) => onOAuthClientIdChange(e.target.value)}
                    autoComplete="off"
                    placeholder={t("localizationConnections.optional116")}
                    className="mt-2 h-11 font-mono"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-client-secret">{t("localizationConnections.clientSecret117")}</label>
                  <Input
                    id="generic-mcp-client-secret"
                    type="password"
                    autoComplete="off"
                    value={oauthClientSecret}
                    onChange={(e) => onOAuthClientSecretChange(e.target.value)}
                    placeholder={t("localizationConnections.optional116")}
                    className="mt-2 h-11 font-mono"
                  />
                </div>
              </div>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>{t("localizationConnections.back63")}</Button>
        <Button onClick={onConnect} disabled={submitting || !canSubmit || Boolean(headerError)}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitting ? t("pages.apps.connect.checking") : t("pages.apps.connect.checkLink")}
        </Button>
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
    get label() { return t("localizationConnections.letPaperclipCheck118"); },
    get hint() { return t("localizationConnections.paperclipAsksTheServerWhatItNeedsAndWalksYouT119"); },
  },
  {
    mode: "none",
    get label() { return t("localizationConnections.noSignInNeeded120"); },
    get hint() { return t("localizationConnections.theServerIsOpenToAnyoneWithTheAddress121"); },
  },
  {
    mode: "bearer",
    get label() { return t("localizationConnections.keyOrToken122"); },
    get hint() { return t("localizationConnections.paperclipSendsYourKeyAsAnAuthorizationHeader123"); },
  },
  {
    mode: "custom_headers",
    get label() { return t("localizationConnections.customHeaders124"); },
    get hint() { return t("localizationConnections.forServersThatNameTheirOwnHeadersValuesAreSto125"); },
  },
  {
    mode: "oauth",
    get label() { return t("localizationConnections.browserSignIn126"); },
    get hint() { return t("localizationConnections.youLlSignInAtTheProviderAddAClientIDAndSecret127"); },
  },
];

function SegmentedOption({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  useTranslation();
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

function KeyStep({
  entry,
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
  const { t } = useTranslation();
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
      <label className="text-sm font-medium text-foreground">{t("localizationConnections.whatShouldPaperclipBeAbleToDo128")}</label>
      <RadioCardGroup
        ariaLabel={t("localizationConnections.appAccessLevel", { app: entry.name })}
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
          title: appDefinitionText(entry, group.label),
          description: appDefinitionText(entry, group.description),
        }))}
      />
      {!capabilityKey && <p className="mt-2 text-xs text-muted-foreground">{t("localizationConnections.chooseAnAccessLevelToContinue130")}</p>}
    </div>
  ) : null;
  const authenticationSelection = capabilityMethods.length > 1 ? (
    <div>
      <label className="text-sm font-medium text-foreground">{t("localizationConnections.howDoYouWantToConnect131")}</label>
      <RadioCardGroup
        ariaLabel={t("localizationConnections.appConnectionMethod", { app: entry.name })}
        className="mt-2"
        value={methodKey}
        onValueChange={(nextKey) => {
          const nextMethod = capabilityMethods.find((candidate) => candidate.key === nextKey);
          if (nextMethod) onMethodChange(nextMethod);
        }}
        options={capabilityMethods.map((candidate) => ({
          value: candidate.key,
          title: candidate.label ? appDefinitionText(entry, candidate.label) : (candidate.auth === "oauth" ? t("localizationConnections.signInApp", { app: entry.name }) : t("localizationConnections.useAnAPIKey134")),
        }))}
      />
      {!method && <p className="mt-2 text-xs text-muted-foreground">{t("localizationConnections.chooseAConnectionMethodToContinue135")}</p>}
    </div>
  ) : null;

  if (isGoogleSheetsRobotMethod(entry, method)) {
    const parsed = parseGoogleSheetIds(googleSheetsLinks);
    const canConnect = !unavailable && Boolean(robotEmail) && googleSheetsLinks.trim().length > 0;
    return (
      <div className="mx-auto max-w-xl">
        <div className="space-y-6">
          {capabilitySelection}

          {robotEmail ? (
            <div>
              <label className="text-sm font-medium text-foreground">{t("pages.apps.connect.googleSheets.shareEmail")}</label>
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
                  <Copy className="mr-2 h-4 w-4" />{t("localizationConnections.copy136")}</Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t("pages.apps.connect.googleSheets.shareInstructions")}</p>
            </div>
          ) : (
            <div className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">{t("pages.apps.connect.googleSheets.unavailable")}</div>
          )}

          <div>
            <label className="text-sm font-medium text-foreground">{t("pages.apps.connect.googleSheets.linksLabel")}</label>
            <Textarea
              value={googleSheetsLinks}
              onChange={(e) => onGoogleSheetsLinksChange(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="mt-2 min-h-28"
            />
            <div className="mt-2 text-xs text-muted-foreground">
              {parsed.ids.length > 0
                ? t("localizationConnections.sheetsReady", { count: parsed.ids.length })
                : t("pages.apps.connect.googleSheets.linksHint")}
            </div>
            {googleSheetsError && <div className="mt-2 text-xs text-destructive">{googleSheetsError}</div>}
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={onBack} disabled={submitting}>{t("localizationConnections.back63")}</Button>
          <Button onClick={onConnect} disabled={submitting || !canConnect}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? t("pages.apps.connect.checking") : t("localizationConnections.connect138")}
          </Button>
        </div>
      </div>
    );
  }

  const requirementsUrl = method?.consoleLinks?.docs ?? entry.docsUrl;

  return (
    <div className="mx-auto max-w-xl">
      {requirementsUrl ? (
        <div className="mb-4 flex justify-end">
          <a
            href={requirementsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >{t("localizationConnections.reviewRequirements139")}<ArrowUpRight className="h-3 w-3" />
          </a>
        </div>
      ) : null}

      <div className="space-y-6">
        {capabilitySelection}
        {authenticationSelection}

        {usingVercel && vercelReview && vercelConnectAvailability ? (
          <div className="space-y-4 rounded-lg border border-border p-4">
            <div>
              <div className="text-sm font-medium text-foreground">{t("localizationConnections.createOrAttachTheConnectorInVercel140")}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t("localizationConnections.paperclipDoesNotCopyVercelSSetupFormsFinishCo141")}</p>
              <a
                href={vercelConnectAvailability.manageUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
              >{t("localizationConnections.openVercelConnect89")}<ArrowUpRight className="h-3 w-3" />
              </a>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="vercel-connect-connector">{t("localizationConnections.connectorUIDOrID142")}</label>
              <Input
                id="vercel-connect-connector"
                value={vercelConnector}
                onChange={(event) => onVercelConnectorChange(event.target.value)}
                autoComplete="off"
                placeholder={t("localizationConnections.connectorIdPlaceholder")}
                className="mt-2 h-11 font-mono"
              />
              <p className="mt-2 text-xs text-muted-foreground">{t("localizationConnections.paperclipValidatesTheConnectorAndStoresOnlyIt144")}</p>
            </div>
          </div>
        ) : null}

        {standardConfigFields.map((field) => (
          <MethodConfigField
            key={field.key}
            appSlug={entry.slug}
            field={field}
            value={configValues[field.key]}
            onChange={(value) => onConfigChange({ ...configValues, [field.key]: value })}
          />
        ))}

        {hasAdvancedSettings && (
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />{t("localizationConnections.advanced146")}</CollapsibleTrigger>
            <CollapsibleContent className="pt-4">
              <div className="space-y-6">
                {advancedConfigFields.map((field) => (
                  <MethodConfigField
                    key={field.key}
                    appSlug={entry.slug}
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

        {usingVercel || !method || fields.length === 0 ? null : (
          fields.map((field) => (
            <div key={field.configPath}>
              <label className="text-sm font-medium text-foreground">
                {credentialFieldLabel(entry.name, appDefinitionText(entry, field.label), fields.length)}
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
                >{t("pages.apps.connect.whereFindKey")}<ArrowUpRight className="h-3 w-3" />
                </a>
              )}
            </div>
          ))
        )}

      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>{t("localizationConnections.back63")}</Button>
        <Button onClick={onConnect} disabled={submitting || !hasMethodSelection || !allFilled || !oauthClientFilled || !vercelConnectorFilled || !configFilled || !configRequirementMet}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitting
            ? t("pages.apps.connect.checking")
            : usingVercel
              ? method?.auth === "oauth" ? t("localizationConnections.validateAndContinue147") : t("localizationConnections.validateAndConnect148")
              : method?.auth === "oauth"
                ? entry.slug === "github" ? t("localizationConnections.continueToGitHub149") : t("localizationConnections.continueToSignIn150")
                : t("localizationConnections.connect138")}
        </Button>
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
  const { t } = useTranslation();
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <div className="text-sm font-medium text-foreground">
          {required ? t("localizationConnections.yourOAuthApp151") : t("localizationConnections.useYourOwnOAuthApp152")}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("localizationConnections.registerCallback", { app: entry.name })}
        </p>
        {method.consoleLinks?.register ? (
          <a
            href={method.consoleLinks.register}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
          >
            {t("localizationConnections.openAppSettings", { app: entry.name })}
            <ArrowUpRight className="h-3 w-3" />
          </a>
        ) : null}
      </div>
      {callbackUrl ? (
        <div>
          <label className="text-sm font-medium text-foreground">{t("localizationConnections.paperclipCallbackURL157")}</label>
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
              <Copy className="mr-2 h-4 w-4" />{t("localizationConnections.copy136")}</Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("localizationConnections.exactCallbackRequired", { app: entry.name })}
          </p>
        </div>
      ) : null}
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="curated-oauth-client-id">{t("localizationConnections.clientID115")}</label>
        <Input
          id="curated-oauth-client-id"
          value={clientId}
          onChange={(event) => onClientIdChange(event.target.value)}
          autoComplete="off"
          placeholder={required ? t("localizationConnections.required160") : t("localizationConnections.optional116")}
          className="mt-2 h-11 font-mono"
        />
      </div>
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="curated-oauth-client-secret">{t("localizationConnections.clientSecret117")}</label>
        <Input
          id="curated-oauth-client-secret"
          type="password"
          value={clientSecret}
          onChange={(event) => onClientSecretChange(event.target.value)}
          autoComplete="off"
          placeholder={t("localizationConnections.optionalForPublicClients161")}
          className="mt-2 h-11 font-mono"
        />
      </div>
    </div>
  );
}

function MethodConfigField({
  appSlug,
  field,
  value,
  onChange,
}: {
  appSlug: string;
  field: FieldDef;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const { t } = useTranslation();
  const label = appDefinitionText(appSlug, field.label);
  const helper = field.helperMd ? appDefinitionText(appSlug, field.helperMd) : null;
  const placeholder = field.placeholder ? appDefinitionText(appSlug, field.placeholder) : undefined;
  if (field.type === "checkbox") {
    return (
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          {helper && <div className="mt-1 text-xs text-muted-foreground">{helper}</div>}
        </div>
        <ToggleSwitch checked={value === true} onCheckedChange={onChange} aria-label={label} />
      </div>
    );
  }
  return (
    <div>
      <label className="text-sm font-medium text-foreground">{label}</label>
      {field.type === "textarea" ? (
        <Textarea
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="mt-2 min-h-24"
        />
      ) : field.type === "select" ? (
        <select
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className="mt-2 h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <option value="" disabled>{t("localizationConnections.selectAnOption162")}</option>
          {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{appDefinitionText(appSlug, option.label)}</option>)}
        </select>
      ) : (
        <Input
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="mt-2 h-11"
        />
      )}
      {helper && <p className="mt-2 text-xs text-muted-foreground">{helper}</p>}
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
  githubIdentity = false,
  submitLabel,
  continuesToProvider = false,
  identityLoading = false,
  preserveAgentAccess = false,
  pending = false,
  onBack,
  onContinue,
}: {
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
  capabilities?: Pick<ToolConnectionCreateCapabilities, "canCreateOrganizationGrant" | "canSetCompanyInstall"> & {
    organizationGrantReason?: string | null;
    companyInstallReason?: string | null;
    editableAgentIds?: string[];
  } | null;
  githubIdentity?: boolean;
  submitLabel: string;
  /** Only show an external-handoff cue when this action starts provider OAuth. */
  continuesToProvider?: boolean;
  /** Wait for a durable OAuth connection before showing a reconnect identity. */
  identityLoading?: boolean;
  /** Reconnect changes credentials only; existing install reach stays intact. */
  preserveAgentAccess?: boolean;
  pending?: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const allAgents: Agent[] = (agentsQuery.data ?? []).filter((a) => a.status !== "terminated");
  // "Only agents I choose" / "Just agents I pick" means agents this person may actually edit. When the server
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
  const canCreateOrganizationGrant = capabilities?.canCreateOrganizationGrant ?? true;
  const needsIdentityChoice = authKind !== "none";
  const allowedGrantKinds = grantKinds ?? (["user", "organization"] satisfies ConnectionGrantKind[]);
  const identityChoiceAllowed = !needsIdentityChoice
    || grantKind === "user"
    || grantKind === "agent"
    || canCreateOrganizationGrant;
  const canContinue = identityChoiceAllowed && (preserveAgentAccess
    ? true
    : lockedAgentId
    ? installAgentIds.has(lockedAgentId)
    : grantKind === "agent"
    ? installChoice === "specific" && installAgentIds.size === 1
    : installChoice === "all"
    ? canSetCompanyInstall
    : installAgentIds.size > 0);
  const lockedAgentName = lockedAgentId
    ? allAgents.find((agent) => agent.id === lockedAgentId)?.name ?? t("localizationConnections.theRequestingAgent165")
    : null;
  const identityHeading = githubIdentity ? t("localizationConnections.connectGitHubAs166") : t("localizationConnections.whichHumansCanUseThisCredential167");
  const agentAccessHeading = grantKind === "agent"
    ? t("localizationConnections.whichAgentOwnsThisGitHubAccount168")
    : githubIdentity && grantKind === "user"
      ? t("localizationConnections.whichAgentsMayUseYourGitHubWhenYouReResponsib169")
      : githubIdentity
        ? t("localizationConnections.whichAgentsMayUseTheSharedGitHubAccount170")
        : t("localizationConnections.whichAgentsCanUseThisConnection171");
  const agentAccessLabel = githubIdentity ? agentAccessHeading : t("localizationConnections.whichAgentsCanUseThisConnection171");

  return (
    <div className="mx-auto max-w-2xl">
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="divide-y divide-border">
          <section className="p-6">
            <h2 className="text-sm font-semibold text-foreground">{identityHeading}</h2>
            {identityLoading ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2" aria-label={t("localizationConnections.loadingConnectionIdentity172")}>
                <Skeleton className="h-20 w-full rounded-md" />
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            ) : needsIdentityChoice && allowedGrantKinds.length === 1 ? (
              <div className="mt-4 flex items-center gap-3 rounded-md border border-border p-4">
                {allowedGrantKinds[0] === "user" ? (
                  <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : allowedGrantKinds[0] === "agent" ? (
                  <Bot className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {allowedGrantKinds[0] === "user"
                      ? githubIdentity ? t("localizationConnections.myGitHubAccount173") : t("localizationConnections.justMe174")
                      : allowedGrantKinds[0] === "agent"
                        ? t("localizationConnections.aDedicatedAccountForAnAgent175")
                        : githubIdentity ? t("localizationConnections.sharedCompanyGitHubAccountAdvanced176") : t("localizationConnections.anyHumanInTheCompany177")}
                  </div>
                  {githubIdentity ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {allowedGrantKinds[0] === "user"
                        ? t("localizationConnections.agentsUseItOnlyForRunsWhereYouAreTheResponsib178")
                        : allowedGrantKinds[0] === "agent"
                          ? t("localizationConnections.thatAgentAlwaysUsesThisAccountRegardlessOfWho179")
                          : t("localizationConnections.eligibleAgentsUseOneSharedCredentialRegardles180")}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : needsIdentityChoice ? (
              <RadioCardGroup
                ariaLabel={githubIdentity ? identityHeading : t("localizationConnections.whichHumansCanUseThisCredential167")}
                className="mt-4 sm:grid-cols-2"
                value={grantKind}
                onValueChange={(next) => {
                  const kind = next as ConnectionGrantKind;
                  setGrantKind(kind);
                  if (kind === "agent") {
                    setInstallChoice("specific");
                    if (installAgentIds.size > 1) setInstallAgentIds(new Set([[...installAgentIds][0]!]));
                  }
                }}
                options={[
                  {
                    value: "user",
                    title: githubIdentity ? t("localizationConnections.myGitHubAccount173") : t("localizationConnections.justMe174"),
                    description: githubIdentity
                      ? t("localizationConnections.agentsUseItOnlyForRunsWhereYouAreTheResponsib178")
                      : undefined,
                    icon: <UserRound className="h-4 w-4" aria-hidden="true" />,
                  },
                  {
                    value: "agent",
                    title: t("localizationConnections.aDedicatedAccountForAnAgent175"),
                    description: githubIdentity
                      ? t("localizationConnections.thatAgentAlwaysUsesThisAccountRegardlessOfWho179")
                      : undefined,
                    icon: <Bot className="h-4 w-4" aria-hidden="true" />,
                  },
                  {
                    value: "organization",
                    title: githubIdentity ? t("localizationConnections.sharedCompanyGitHubAccountAdvanced176") : t("localizationConnections.anyHumanInTheCompany177"),
                    description: githubIdentity
                      ? t("localizationConnections.eligibleAgentsUseOneSharedCredentialRegardles180")
                      : undefined,
                    icon: <UsersRound className="h-4 w-4" aria-hidden="true" />,
                    accessibleLabel: canCreateOrganizationGrant
                      ? githubIdentity ? t("localizationConnections.sharedCompanyGitHubAccountAdvanced176") : t("localizationConnections.anyHumanInTheCompany177")
                      : t("localizationConnections.unavailableOption", { option: githubIdentity ? t("localizationConnections.sharedCompanyGitHubAccountAdvanced176") : t("localizationConnections.anyHumanInTheCompany177"), reason: capabilities?.organizationGrantReason ?? t("localizationConnections.onlyAConnectionManagerCanShareThisCredentialW182") }),
                    tooltip: canCreateOrganizationGrant
                      ? undefined
                      : capabilities?.organizationGrantReason ??
                        t("localizationConnections.onlyAConnectionManagerCanShareThisCredentialW182"),
                    disabled: !canCreateOrganizationGrant,
                  },
                ].filter((option) => allowedGrantKinds.includes(option.value as ConnectionGrantKind))}
              />
            ) : (
              // A connection with no credential has no identity to choose, so
              // asking would be a meaningless decision.
              <p className="mt-4 text-sm text-muted-foreground">{t("localizationConnections.noIdentityRequired183")}</p>
            )}
          </section>

          <section className="p-6">
            <h2 className="text-sm font-semibold text-foreground">{agentAccessHeading}</h2>
            {preserveAgentAccess ? (
              <div className="mt-4 flex items-start gap-3 rounded-md border border-border bg-muted/40 p-4">
                <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <div className="text-sm font-medium text-foreground">{t("localizationConnections.existingAgentAccessStaysTheSame184")}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{t("localizationConnections.reconnectingReplacesTheCredentialWithoutChang185")}</p>
                </div>
              </div>
            ) : lockedAgentId ? (
              <p className="mt-2 text-sm text-muted-foreground">
                <Trans t={t} i18nKey="localizationConnections.lockedAgentAccess" values={{ agent: lockedAgentName }} components={{ agent: <span className="font-medium text-foreground" /> }} />
              </p>
            ) : (
              grantKind === "agent" ? (
                <p className="mt-2 text-sm text-muted-foreground">{t("localizationConnections.chooseExactlyOneAgentThisIdentityCannotBeShar188")}</p>
              ) : <RadioCardGroup
                ariaLabel={agentAccessLabel}
                className="mt-4 sm:grid-cols-2"
                value={installChoice}
                onValueChange={(next) => setInstallChoice(next as "specific" | "all")}
                options={[
                  {
                    value: "specific",
                    title: githubIdentity ? t("localizationConnections.onlyAgentsIChoose189") : t("localizationConnections.justAgentsIPick190"),
                    description: githubIdentity
                      ? grantKind === "user"
                        ? t("localizationConnections.onlySelectedAgentsMayUseYourGitHubWhenYouReRe191")
                        : t("localizationConnections.onlySelectedAgentsMayUseTheSharedAccount192")
                      : undefined,
                    icon: <Bot className="h-4 w-4" aria-hidden="true" />,
                  },
                  {
                    value: "all",
                    title: t("localizationConnections.anyAgent193"),
                    description: githubIdentity
                      ? grantKind === "user"
                        ? t("localizationConnections.everyAgentMayUseYourGitHubWhenYouReResponsibl194")
                        : t("localizationConnections.everyAgentMayUseTheSharedAccount195")
                      : undefined,
                    icon: <BotGroupIcon />,
                    accessibleLabel: canSetCompanyInstall
                      ? t("localizationConnections.anyAgent193")
                      : t("localizationConnections.unavailableOption", { option: t("localizationConnections.anyAgent193"), reason: capabilities?.companyInstallReason ?? t("localizationConnections.onlySomeoneWhoCanConfigureThisConnectionCanCh197") }),
                    tooltip: canSetCompanyInstall
                      ? undefined
                      : capabilities?.companyInstallReason ??
                        t("localizationConnections.onlySomeoneWhoCanConfigureThisConnectionCanCh197"),
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
                  onChange={(next) => setInstallAgentIds(
                    grantKind === "agent" && next.size > 1 ? new Set([[...next].at(-1)!]) : next,
                  )}
                  loading={agentsQuery.isLoading}
                  emptyMessage={t("localizationConnections.youCannotEditAnyAgentsYet198")}
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
        <Button variant="ghost" className="w-full sm:w-auto" onClick={onBack} disabled={pending}>{t("localizationConnections.back63")}</Button>
        <Button
          className="w-full sm:w-auto"
          onClick={onContinue}
          disabled={!canContinue || identityLoading || pending}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {submitLabel}
          {!pending && continuesToProvider ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
        </Button>
      </div>
    </div>
  );
}

function BotGroupIcon() {
  useTranslation();
  return (
    <span className="relative block h-4 w-5" aria-hidden="true">
      <Bot className="absolute left-0 top-0 h-3.5 w-3.5" />
      <Bot className="absolute bottom-0 right-0 h-3.5 w-3.5" />
    </span>
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
    ? t("localizationConnections.noIdentityRequired183")
    : input.grantKind === "user"
      ? t("localizationConnections.yourIdentity199")
      : input.grantKind === "agent"
        ? t("localizationConnections.dedicatedAgentIdentity200")
      : t("localizationConnections.organizationIdentity201");
  const availableTo = input.installChoice === "all"
    ? t("localizationConnections.anyAgent193")
    : t("localizationConnections.selectedAgents", { count: input.installCount });
  return [
    { label: t("localizationConnections.identity203"), value: identity },
    { label: t("localizationConnections.availableTo204"), value: availableTo },
    {
      label: t("localizationConnections.actions205"),
      value: t("localizationConnections.actionsOn", { count: input.enabledCount }),
    },
  ];
}

function Radio({ selected }: { selected: boolean }) {
  useTranslation();
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
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 border-emerald-500 bg-emerald-500/10">
        <Check className="h-9 w-9 text-emerald-600 dark:text-emerald-400" />
      </div>
      <div className="mt-6 flex items-center justify-center gap-2">
        <AppLogo name={appName} logoUrl={logoUrl} darkLogoUrl={darkLogoUrl} size={28} />
        <h2 className="text-2xl font-bold tracking-tight">{t("localizationConnections.appReady", { app: appName })}</h2>
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
        <Button size="lg" className="px-10" onClick={onDone}>{t("localizationConnections.viewConnection209")}</Button>
      </div>
    </div>
  );
}
