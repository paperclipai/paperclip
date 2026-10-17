import { healthApi } from "@/api/health";
import { aiConnectionsApi } from "@/api/ai-connections";
import { useLocalAiLogin } from "../ai-connections/useLocalAiLogin";
import type { AiConnectionBinding, AiConnectionLoginIntent, LocalClaudeConfigReadResult } from "@paperclipai/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cable } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  SavedProviderKeySelect,
  useSavedProviderKeys,
} from "../onboarding/SavedProviderKeySelect";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { AdapterLoginPanel } from "../AgentConfigForm";
import { AdapterMark } from "./AgentBasicsDialog";
import {
  LocalProviderLoginInstructions,
  OnboardingCardField,
  OnboardingLoginCard,
} from "../AdapterLoginChrome";
import { ModelSourceTiles, type ModelConnectionMode } from "../onboarding/ModelSourceTiles";
import { CredentialModeLink } from "../onboarding/CredentialModeLink";
import { FooterNav } from "../onboarding/FooterNav";
import { MAKE_ROOM, CARD_ENTER } from "../onboarding/onboarding-motion";
import { buildFixedClaudeOAuthBinding } from "../environment-variables-editor/model";
import {
  IMPORT_READ_GUIDANCE,
  canOfferClaudeConfigImport,
  resolveImportModel,
} from "@/lib/claude-config-import";
import type { EnvBinding } from "@paperclipai/shared";
import { ClaudeConfigImportCard, importFailureMessage, type ImportReadState } from "./ClaudeConfigImportCard";

export type ProviderConnection = {
  env: Record<string, EnvBinding>;
  aiConnection?: AiConnectionBinding;
  /** Kept in memory until the user finishes setup. */
  credentials?: Record<string, string>;
  storedSessionId?: string;
  applyStoredClaudeLogin?: boolean;
  /**
   * The model an import was confirmed with, for the surface to put in the
   * agent's own model field. Absent for every other way of connecting.
   */
  model?: string;
};

export function AgentProviderConnection({
  companyId,
  adapterType,
  environmentId,
  canLogin,
  localEnvironment = false,
  onConnected,
  onDraftChanged,
  onBack,
  testConnection,
  testError,
  managedAccount,
  advancedConnection,
}: {
  companyId: string;
  adapterType: "claude_local" | "codex_local" | "grok_local";
  environmentId: string | null;
  canLogin: boolean;
  localEnvironment?: boolean;
  onConnected: (connection: ProviderConnection) => void;
  onDraftChanged?: () => void;
  onBack: () => void;
  testConnection: (connection: ProviderConnection) => Promise<boolean>;
  testError?: string | null;
  advancedConnection?: { content: ReactNode; value?: AiConnectionBinding };
  /** Connections supplies its access intent; presentation and login controllers stay shared. */
  managedAccount?: {
    intent: AiConnectionLoginIntent;
    nameForMethod?: (method: "subscription" | "api_key") => string;
    initialMethod?: "subscription" | "api_key";
    fixedMethod?: boolean;
    disabled?: boolean;
    /**
     * Whether this surface may offer the import credential mode. Resolved one
     * level up, where the provider is known explicitly rather than inferred from
     * the adapter — see `importCapable` below for what the gate is. Agent setup
     * has no managed intent to ask, so it answers the same gate itself.
     */
    importCapable?: boolean;
    /**
     * Completed, with the model the import card was confirmed with when there is
     * one. The surface writes that into the agent's model field, which is where
     * it has always lived.
     */
    onComplete: (result: { connectionId: string; grantId: string; method: "subscription" | "api_key"; model?: string }) => void;
  };
}) {
  // Read whether or not this surface signs in locally: the import mode is offered
  // wherever the instance and the provider qualify, and whether the environment
  // an agent resolves to can reach the gateway is the server's call, not this
  // component's (PRODUCT #51, #53). `canUseLocalLogin` still stays behind
  // `localEnvironment`, because the local sign-in beside it does read the host.
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get });
  const canUseLocalLogin = localEnvironment && (health.data?.localAiLoginSupported ?? health.data?.deploymentMode === "local_trusted");
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const cancel = () => {
    epoch.current++;
    setBusy(false);
    setOpened(false);
    setAuthorizationUrl(null);
    setLoginPhase("preparing");
  };
  const [methodChoice, setMethod] = useState<"subscription" | "api" | "import" | null>(managedAccount?.initialMethod === "api_key" ? "api" : managedAccount ? "subscription" : null);
  const [advanced, setAdvanced] = useState(false);
  // Connections already selected the provider before showing this step.
  const [opened, setOpened] = useState(Boolean(advancedConnection || managedAccount));
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loginPhase, setLoginPhase] = useState<"preparing" | "ready" | "waiting" | "connecting">("preparing");
  const phaseBeforeSubmit = useRef<"ready" | "waiting">("ready");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedConnection, setStoredConnection] =
    useState<ProviderConnection | null>(null);
  const credentialModeLinkRef = useRef<HTMLDivElement | null>(null);
  const provider = adapterType === "claude_local" ? "Claude" : adapterType === "grok_local" ? "Grok" : "OpenAI";
  const envKey =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : adapterType === "grok_local" ? "XAI_API_KEY" : "OPENAI_API_KEY";
  const aiProvider = adapterType === "claude_local" ? "anthropic" : adapterType === "grok_local" ? "xai" : "openai";
  /**
   * Whether the import credential mode may be offered at all.
   *
   * One gate, shared with the other three surfaces (`canOfferClaudeConfigImport`):
   * the instance has to be the kind that reads local credentials and `local_trusted`
   * — which is also what makes the caller the operator whose home directory holds
   * the file (PRODUCT #4, #49) — and the provider has to be Anthropic, so the
   * endpoint fields mean something (PRODUCT #3). The connections surface answers
   * for the provider it is connecting because it resolves that one level up; agent
   * setup has no managed intent to ask, so it takes the same facts off the adapter
   * and health here.
   *
   * Nothing here asks about the execution environment. Whether the gateway is
   * reachable from where the agent will actually run is the server's judgement
   * (PRODUCT #51, #53): it knows the agent's driver and its network allowlist, and
   * a surface adding its own condition would both refuse imports the server would
   * have accepted and draw the mode for the ones it would not.
   *
   * The server enforces all of this again on both routes. This only decides whether
   * a control nobody could complete is drawn.
   */
  const importCapable = (managedAccount ? Boolean(managedAccount.importCapable) : true) &&
    canOfferClaudeConfigImport({ provider: aiProvider, health: health.data });
  const availableKeys = useSavedProviderKeys(companyId, envKey);
  // Add/reconnect creates the requested account, never copies a saved account's
  // credential or silently changes its ownership. Agent setup retains reuse.
  const savedKeys = managedAccount
    ? { ...availableKeys, options: [], subscriptions: [], loading: false }
    : availableKeys;
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const savedSubscription =
    savedKeys.subscriptions.length
      ? savedKeys.subscriptions.find(
          (option) =>
            option.id === (subscriptionId ?? savedKeys.subscriptions[0]?.id),
        )
      : undefined;
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const selectedKey = savedKeys.options.find(
    (option) => option.id === (selectedKeyId ?? savedKeys.options[0]?.id),
  );
  const storedLogin = managedAccount
    ? { ...savedKeys.storedLogin, data: undefined, isPending: false, isError: false }
    : savedKeys.storedLogin;
  const savedManagedAccount = useRef<{ connectionId: string; grantId: string } | null>(null);
  const method = methodChoice ?? (
    (savedKeys.subscriptions.length > 0 || (adapterType === "claude_local" && !savedSubscription && storedLogin.data))
      ? "subscription" : savedKeys.options.length ? "api" : "subscription"
  );
  /** Import is a credential mode, so it is only ever in force where it is offered. */
  const importMode = importCapable && method === "import";
  /**
   * The import mode's state: what the read found, and what has since been edited
   * on the confirmation card.
   */
  const [importRead, setImportRead] = useState<ImportReadState>({ status: "idle" });
  const [importName, setImportName] = useState("");
  const [importModel, setImportModel] = useState("");
  const [importModelEditing, setImportModelEditing] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importRunRef = useRef(0);
  /**
   * The connection this surface's own import created, if it made one.
   *
   * Remembered so a second import from the same surface reconnects the account it
   * already made instead of building a second one beside it: the same provider and
   * the same method would differ in nothing but an id, and the reader would be
   * picking between two connections they believe to be one. The managed branch
   * keeps its answer in `savedManagedAccount`; this is the same guard for the
   * surfaces that connect an agent rather than an account.
   */
  const importedConnection = useRef<{ connectionId: string; grantId: string; model: string } | null>(null);
  /** Where the reader was when they took the import detour. */
  const methodBeforeImport = useRef<"subscription" | "api">("subscription");
  /** Focus the mode link once the card has closed and put it back on screen (#48). */
  const returnFocusToModeLinkRef = useRef(false);
  // The card's model row carries the imported tiers plus the same static list every
  // other surface picks from (PRODUCT #19). Only read while the card is on screen:
  // the list is not needed by either of the other two modes.
  const importModels = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType, environmentId ?? null),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType, { environmentId }),
    enabled: importMode && importRead.status === "ready",
  });
  /**
   * Drop everything the import card was holding, without touching the mode.
   *
   * Called both on the way in — so a second visit re-reads rather than showing
   * what the first found (PRODUCT #9) — and on the way out (PRODUCT #7).
   */
  const discardImport = () => {
    importRunRef.current++;
    setImportRead({ status: "idle" });
    setImportName("");
    setImportModel("");
    setImportModelEditing(false);
    setImportError(null);
  };

  /**
   * Read the operator's own Claude settings from the machine running Paperclip.
   *
   * No arguments, and that is the point (PRODUCT #8): the route takes no path and
   * no credential, so there is nothing here to pass and nothing for a caller to
   * point it at. The response carries a masked key and never the value.
   */
  const readLocalClaudeConfig = () => {
    const run = ++importRunRef.current;
    setImportRead({ status: "reading" });
    setImportError(null);
    void aiConnectionsApi.readLocalClaudeConfig(companyId)
      .then((result) => {
        // A mode switch or a cancel has already moved this card on.
        if (run !== importRunRef.current) return;
        if (result.status === "ok") {
          setImportRead({ status: "ready", result });
          setImportName(result.suggestedName);
          setImportModel(result.models.default);
          setImportModelEditing(false);
          return;
        }
        setImportRead({
          status: "unavailable",
          message: result.message,
          // Keyed by the reason the route reports rather than by its message: the
          // sentence has to name the missing variable and the file it belongs in,
          // and the server is free to reword its own copy.
          guidance: IMPORT_READ_GUIDANCE[result.reason],
        });
      })
      .catch((err: unknown) => {
        if (run !== importRunRef.current) return;
        // A refusal is the server's own answer — an untrusted instance, a caller
        // who is not the operator — and it knows what it refused. Pointing at the
        // settings file on top of that would be guessing at a cause it did not give.
        const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
        setImportRead({
          status: "unavailable",
          message: err instanceof Error && err.message ? err.message : "Could not read this machine's Claude config.",
          ...(refused ? {} : { guidance: IMPORT_READ_GUIDANCE.settings_unreadable }),
        });
      });
  };
  /**
   * Entering the import mode is the action: the read goes out on entry and again
   * on every return, because the file is the only source and it may have been
   * edited since the last look (PRODUCT #9).
   *
   * The card is the thing that shows the answer, so entering the mode also opens
   * the provider row — otherwise the read would land in a collapsed section
   * nobody had asked for.
   */
  useEffect(() => {
    if (!importMode) return;
    setOpened(true);
    if (importRead.status === "idle") readLocalClaudeConfig();
  }, [importMode, importRead.status]);
  /**
   * Leave the import mode, and leave nothing of the card behind (PRODUCT #7).
   *
   * Also the Cancel on the card itself, including while a probe is in flight
   * (PRODUCT #22): the probe writes nothing when it fails, so a reader who has
   * changed their mind only ever abandons their own state. Bumping the run stops
   * the flow that probe belonged to — without it the press would still go on to
   * the environment test and report a connection the reader just walked away
   * from — while the connection itself, if the probe lands anyway, is remembered
   * in `importedConnection` so the next import reconnects it rather than building
   * a second one.
   */
  const leaveImport = () => {
    discardImport();
    epoch.current++;
    setBusy(false);
    // Back to wherever the reader was before they took the detour, not to whatever
    // this surface happens to default to.
    setMethod(methodBeforeImport.current);
    setOpened(false);
    returnFocusToModeLinkRef.current = true;
  };
  /**
   * Hand focus back to the mode link once the card has closed (#48).
   *
   * Not in the leaving call itself, because on this surface the link is not in the
   * DOM while the card is open — the row collapses into the provider section above
   * it — so a focus call made at that moment would land on `body` and put the
   * keyboard back at the top of the document. The link remounts as the row comes
   * back, and `opened` is the state that move is driven by.
   */
  useEffect(() => {
    if (!returnFocusToModeLinkRef.current) return;
    const link = credentialModeLinkRef.current?.querySelector("button");
    if (!(link instanceof HTMLButtonElement)) return;
    returnFocusToModeLinkRef.current = false;
    link.focus();
  }, [opened]);
  /**
   * Esc closes the confirmation card, and closing it is cancelling it (#48).
   *
   * Bound to the window rather than the card: the card is an inline canvas, so
   * focus can sit on the step behind it, and a keypress there still means "get me
   * out of this".
   */
  useEffect(() => {
    if (!importMode) return;
    if (importRead.status !== "ready" && importRead.status !== "unavailable") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      leaveImport();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [importMode, importRead.status]);
  /** The tiers the read folded, then the adapter's own list — in that order (PRODUCT #19). */
  const importModelOptions = (() => {
    if (importRead.status !== "ready") return [] as AdapterModel[];
    const result = importRead.result;
    const options: AdapterModel[] = [];
    const seen = new Set<string>();
    const push = (id: string, label?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      options.push({ id, label: label ?? id });
    };
    push(result.models.default);
    for (const alternative of result.models.alternatives) push(alternative);
    for (const entry of importModels.data ?? []) push(entry.id, entry.label);
    return options;
  })();
  const authMethod = importMode ? "api_key" : method === "api" ? "api_key" : "subscription";
  // Reconnect preserves an account's method. Choosing another method creates
  // an account for the same provider; the task host selects it after sign-in.
  const reconnecting = managedAccount?.intent.connectionId && (
    managedAccount.fixedMethod !== false || managedAccount.initialMethod === authMethod
  );
  const managedIntent: AiConnectionLoginIntent | undefined = managedAccount ? {
    ...managedAccount.intent,
    connectionId: reconnecting ? managedAccount.intent.connectionId : undefined,
    name: reconnecting
      ? managedAccount.intent.name
      : managedAccount.nameForMethod?.(authMethod) ?? managedAccount.intent.name,
  } : undefined;
  const localLogin = useLocalAiLogin(companyId, managedIntent ?? {
    provider: aiProvider, method: "subscription", name: `My ${provider} subscription`,
    ownership: "personal", agentIds: [], allAgents: true,
  }, !advanced && canUseLocalLogin && !importMode && method === "subscription" && !savedSubscription && !storedLogin.data);
  const auth = useQuery({
    queryKey: queryKeys.agents.authSignal(
      companyId,
      adapterType,
      environmentId,
    ),
    queryFn: () =>
      agentsApi.getAdapterAuthSignal(
        companyId,
        adapterType,
        environmentId ?? undefined,
      ),
    retry: false,
    enabled: !managedAccount && !advanced,
  });
  /**
   * Turn the snapshot the reader confirmed into a connection.
   *
   * Everything this sends is either a summary the server will re-read and
   * field-compare for itself, or nothing at all — the key never travels here
   * (PRODUCT #11, #41). `confirm` carries the values as they were *read*, not as
   * they were edited: it exists so the server can tell "the file moved under the
   * reader" from "the reader changed their mind", and echoing an edit would make
   * the first look like the second. `model` is the edit, and it travels as itself:
   * it is the model the reader chose on the card, and it is what this surface
   * writes into the agent's own model field once the connection exists.
   *
   * A second import from the same surface names the connection the first one made,
   * so a retry — or a re-import after a failed environment test — reconnects the
   * account rather than building a second one beside it. A surface that arrived
   * reconnecting an account keeps naming that one, exactly as the other two modes
   * do.
   */
  const importClaudeConfig = async () => {
    if (importRead.status !== "ready") throw new Error("Read this machine's Claude config before importing.");
    const snapshot = importRead.result;
    const model = resolveImportModel(importModel, snapshot);
    const connectionId = importedConnection.current?.connectionId ?? managedIntent?.connectionId;
    const saved = await aiConnectionsApi.importLocalClaudeConfig(companyId, {
      provider: "anthropic",
      method: "api_key",
      name: importName.trim() || snapshot.suggestedName,
      // The same ownership this surface gives a typed API key; import adds no
      // concept of its own (PRODUCT #20).
      ownership: managedAccount?.intent.ownership ?? "personal",
      agentIds: managedAccount?.intent.agentIds ?? [],
      allAgents: managedAccount?.intent.allAgents ?? true,
      ...(connectionId ? { connectionId } : {}),
      // The environment this surface selected for the agent it is about to
      // create. The server judges reachability there, not against the instance
      // default, which can point somewhere the operator never chose.
      ...(environmentId ? { environmentId } : {}),
      baseUrl: snapshot.baseUrl,
      keyVariable: snapshot.keyVariable,
      model,
      confirm: {
        keyVariable: snapshot.keyVariable,
        maskedKey: snapshot.maskedKey,
        defaultModel: snapshot.models.default,
        alternativeModels: snapshot.models.alternatives,
      },
    });
    // Remembered whether or not this flow goes on to report it: a press that was
    // cancelled mid-probe has already built the connection server-side, and the
    // next import has to know that to reconnect it instead of duplicating it.
    importedConnection.current = { ...saved, model };
    return { ...saved, model };
  };
  async function connect() {
    if (busy || managedAccount?.disabled) return;
    const run = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      if (managedAccount && managedIntent) {
        if (method === "subscription" && !canUseLocalLogin) return;
        const result = savedManagedAccount.current ?? await (importMode
          ? importClaudeConfig()
          : method === "api"
          ? aiConnectionsApi.create(companyId, { ...managedIntent, method: "api_key", apiKey: apiKey.trim() })
          : localLogin.connect(managedIntent));
        savedManagedAccount.current = result;
        setApiKey("");
        if (run === epoch.current) managedAccount.onComplete({ ...result, method: authMethod });
        return;
      }
      let connection: ProviderConnection =
        method === "api"
          ? selectedKey
            ? selectedKey.aiConnection ? { env: {}, aiConnection: selectedKey.aiConnection } : { env: { [envKey]: selectedKey.binding } }
            : (storedConnection ?? {
                env: {},
                credentials: { [envKey]: apiKey.trim() },
              })
          : {
              ...(savedSubscription?.aiConnection ? { aiConnection: savedSubscription.aiConnection } : {}),
              env: savedSubscription?.binding
                ? { CODEX_HOME: savedSubscription.binding }
                : {},
              ...(adapterType === "claude_local" && !savedSubscription && storedLogin.data
                ? {
                    env: buildFixedClaudeOAuthBinding(),
                    applyStoredClaudeLogin: true,
                  }
                : {}),
            };
      if (method === "subscription" && canUseLocalLogin && !savedSubscription && !storedLogin.data) {
        savedManagedAccount.current ??= await localLogin.connect();
        connection = { env: {}, aiConnection: { provider: aiProvider, method: "subscription", mode: "responsible_user" } };
      }
      if (importMode) {
        // The route has already read the file, probed the gateway and written the
        // connection, so the account exists by the time we get here; the
        // environment test below is the same one a typed API key gets.
        const saved = await importClaudeConfig();
        connection = {
          env: {},
          aiConnection: { provider: aiProvider, method: "api_key", mode: "responsible_user" },
          // The model the card was confirmed with rides along with the connection:
          // the surface owns the agent's model field, and the import chose it on
          // the reader's behalf.
          model: saved.model,
        };
      } else if (connection.credentials) {
        await aiConnectionsApi.create(companyId, { provider: aiProvider, method: "api_key", name: `My ${provider} API`, ownership: "personal", apiKey: connection.credentials[envKey], agentIds: [], allAgents: true });
        connection = { env: {}, aiConnection: { provider: aiProvider, method: "api_key", mode: "responsible_user" } };
      }
      if (run !== epoch.current) return;
      if (method === "api") {
        setApiKey("");
        if (!selectedKey) setStoredConnection(connection);
      }
      const connected = await testConnection(connection);
      if (run !== epoch.current) return;
      if (connected) onConnected(connection);
      else
        setError(
          "The provider did not respond. Check the connection and try again.",
        );
    } catch (cause) {
      if (run !== epoch.current) return;
      if (managedAccount) setApiKey("");
      // A refused import belongs to the card, which keeps standing with its values
      // so the reader can fix the gateway and press Import again (PRODUCT #25).
      if (importMode) setImportError(importFailureMessage(cause));
      else
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not connect to the provider.",
        );
    } finally {
      if (run === epoch.current) setBusy(false);
    }
  }
  const needsLogin =
    method === "subscription" &&
    canLogin &&
    environmentId &&
    !savedSubscription &&
    !savedKeys.loading &&
    !storedLogin.data &&
    (Boolean(managedAccount) || auth.data?.status !== "present" || subscriptionId === "");
  const switchMode = (next: ModelConnectionMode) => {
    if (advancedConnection && next === (advanced ? "advanced" : method)) return;
    onDraftChanged?.();
    cancel();
    setAdvanced(next === "advanced");
    setOpened(advancedConnection ? true : opened);
    savedManagedAccount.current = null;
    if (next !== "advanced") setMethod(next);
    setApiKey("");
    setStoredConnection(null);
    setError(null);
  };
  return (
    <div className="min-w-0 max-w-full">
      <ModelSourceTiles
        label={advancedConnection ? "Connection type" : "Connect your model provider"}
        sources={advancedConnection ? [
          { id: "subscription", label: provider, icon: <AdapterMark type={adapterType} />, credentialMode: "subscription" },
          { id: "api", label: provider, icon: <AdapterMark type={adapterType} />, credentialMode: "api" },
          { id: "advanced", label: "Advanced", icon: <Cable className="size-6 text-muted-foreground" />, credentialMode: "advanced" },
        ] : [
          {
            id: adapterType,
            label: provider,
            icon: <AdapterMark type={adapterType} />,
          },
        ]}
        mode={advanced ? "advanced" : method}
        selectedId={advancedConnection ? (advanced ? "advanced" : method) : opened ? adapterType : null}
        collapsed={!advancedConnection && opened}
        onSelect={id => {
          if (managedAccount?.disabled) return;
          if (advancedConnection) switchMode(id as ModelConnectionMode);
          else setOpened(true);
        }}
      />
      {!advancedConnection && (!opened || managedAccount) && !managedAccount?.fixedMethod && (
        // Where the import card hands focus back to when it closes (PRODUCT #48).
        <div ref={credentialModeLinkRef} className="-ml-3 mt-1">
          <CredentialModeLink
            mode={method}
            // The link walks the modes this surface actually offers, so it never
            // lands on one that will not be drawn.
            availableModes={importCapable ? ["subscription", "api", "import"] : undefined}
            onChange={(next) => {
              cancel();
              setOpened(opened);
              savedManagedAccount.current = null;
              if (next === "import" && method !== "import") methodBeforeImport.current = method;
              setMethod(next);
              setApiKey("");
              setStoredConnection(null);
              setError(null);
              // Entering the import mode is the action, and leaving it abandons the
              // card — either way nothing typed in the other modes survives
              // (PRODUCT #7). Those are unsubmitted form values, so there is
              // nothing to confirm.
              discardImport();
            }}
          />
        </div>
      )}
      {advanced && advancedConnection ? <>
        <div className="pt-5">{advancedConnection.content}</div>
        <FooterNav
          onBack={onBack}
          primaryLabel="Use connection"
          primaryDisabled={!advancedConnection.value}
          onPrimary={() => {
            if (advancedConnection.value) onConnected({ env: {}, aiConnection: advancedConnection.value });
          }}
        />
      </> : <>
      {!opened && savedKeys.options.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {savedKeys.options.length} saved API{" "}
          {savedKeys.options.length === 1 ? "key available" : "keys available"}.
        </p>
      )}
      {method === "subscription" &&
        savedKeys.subscriptions.length > 0 && (
          <div className={advancedConnection ? "pt-5" : undefined}>
            <SavedProviderKeySelect
              options={savedKeys.subscriptions}
              value={savedSubscription?.id ?? ""}
              onChange={(id) => { onDraftChanged?.(); setSubscriptionId(id); }}
              loading={false}
              error={false}
              kind="subscription"
              disabled={busy}
            />
          </div>
        )}
      <motion.div
        initial={false}
        animate={{ height: opened ? "auto" : 0, opacity: opened ? 1 : 0 }}
        transition={{ height: MAKE_ROOM, opacity: CARD_ENTER }}
        className="overflow-hidden"
      >
        {opened && (
          <div className="pt-5">
            {importMode ? (
              <ClaudeConfigImportCard
                read={importRead}
                name={importName}
                model={importModel}
                modelEditing={importModelEditing}
                modelOptions={importModelOptions}
                error={importError}
                onNameChange={setImportName}
                onModelChange={setImportModel}
                onModelEditingChange={setImportModelEditing}
                onCancel={leaveImport}
              />
            ) : method === "api" ? (
              <OnboardingLoginCard
                instruction={
                  savedKeys.options.length
                    ? "Choose a saved API key or enter a new one"
                    : `Provide your ${provider} API key to connect`
                }
              >
                <SavedProviderKeySelect
                  {...savedKeys}
                  value={selectedKey?.id ?? ""}
                  disabled={busy}
                  onChange={(id) => {
                    onDraftChanged?.();
                    setSelectedKeyId(id);
                    setApiKey("");
                    setStoredConnection(null);
                    setError(null);
                  }}
                />
                {!selectedKey && (
                  <OnboardingCardField
                    label="API key"
                    masked
                    autoFocus
                    value={apiKey}
                    placeholder={
                      storedConnection
                        ? "Key entered. Retry the connection."
                        : "Enter API key here"
                    }
                    onChange={(value) => {
                      onDraftChanged?.();
                      setSelectedKeyId("");
                      setApiKey(value);
                      setStoredConnection(null);
                    }}
                    onSubmit={() => void connect()}
                    disabled={busy}
                  />
                )}
              </OnboardingLoginCard>
            ) : needsLogin ? (
              <AdapterLoginPanel
                companyId={companyId}
                adapterType={adapterType}
                environmentId={environmentId}
                chrome="onboarding"
                aiConnection={managedIntent ?? { provider: aiProvider, method: "subscription", name: `My ${provider} subscription`, ownership: "personal", agentIds: [], allAgents: true }}
                autoStart
                onStored={() => {}}
                onPromptReady={(url) => {
                  setAuthorizationUrl(url);
                  setLoginPhase((phase) => url ? (phase === "preparing" ? "ready" : phase) : "preparing");
                }}
                onCodeSubmitted={() => {
                  phaseBeforeSubmit.current = loginPhase === "waiting" ? "waiting" : "ready";
                  setLoginPhase("connecting");
                }}
                onSubmitFailed={() => {
                  setLoginPhase((phase) => phase === "connecting" ? phaseBeforeSubmit.current : phase);
                }}
                onConnected={(sessionId) => {
                  if (managedAccount) {
                    if (!sessionId) { setError("The login did not return a saved connection. Try again."); return; }
                    const run = epoch.current;
                    setLoginPhase("connecting");
                    void aiConnectionsApi.loginResult(companyId, sessionId).then((result) => {
                      if (run === epoch.current) managedAccount.onComplete({ ...result, method: "subscription" });
                    }).catch(() => {
                      if (run !== epoch.current) return;
                      setLoginPhase("ready");
                      setError("Could not retrieve the saved connection. Go back and retry.");
                    });
                    return;
                  }
                  const connection: ProviderConnection = { env: {}, aiConnection: { provider: aiProvider, method: "subscription", mode: "responsible_user" } };
                  setStoredConnection(connection);
                  onConnected(connection);
                }}
              />
            ) : savedSubscription ? null : canUseLocalLogin && !storedLogin.data ? (
              <LocalProviderLoginInstructions adapterType={adapterType} login={{ ...localLogin, retry: () => { setError(null); localLogin.retry(); } }} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {storedLogin.data
                  ? "Use your saved Claude subscription for this agent."
                  : canLogin
                    ? "Use the existing provider connection for this environment."
                    : "This environment does not support browser sign-in. Choose a sign-in environment or connect with an API key."}
              </p>
            )}
          </div>
        )}
      </motion.div>
      {method === "subscription" && storedLogin.isError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          Could not check your saved Claude subscription. Try again.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {testError ?? error}
        </p>
      )}
      {localEnvironment && health.isError && (
        <p role="alert" className="mt-4 text-sm text-destructive">Could not prepare sign-in. Reload this page to try again.</p>
      )}
      <FooterNav
        onBack={() => {
          if (importMode) leaveImport();
          else if (opened && !advancedConnection) cancel();
          else onBack();
        }}
        primaryLabel={
          opened && needsLogin
            ? loginPhase === "waiting" ? "Waiting for code"
              : loginPhase === "connecting" ? "Connecting"
              : `Sign in to ${provider}`
            : importMode
            ? busy ? "Importing…"
              : importRead.status === "reading" ? "Reading…"
              : "Import"
            : busy
            ? "Connecting"
            : method === "subscription" &&
                (storedLogin.data || savedSubscription)
              ? "Use saved subscription"
              : method === "api" && selectedKey
                ? "Use saved API key"
                : "Connect"
        }
        primaryDisabled={
          managedAccount?.disabled ||
          (Boolean(managedAccount) && method === "subscription" && !canLogin && !canUseLocalLogin) ||
          (localEnvironment && health.isPending) || localLogin.preparing || Boolean(localLogin.error) ||
          (method === "subscription" && canUseLocalLogin && !savedSubscription && !storedLogin.data && localLogin.status !== "ready") ||
          (!managedAccount && auth.isPending) ||
          savedKeys.loading ||
          (adapterType === "claude_local" && storedLogin.isPending) ||
          // The saved-subscription chooser renders outside the opened section,
          // so reusing the visible choice must not wait for a tile click.
          (!opened && !(method === "subscription" && savedSubscription)) ||
          (Boolean(needsLogin) && (!authorizationUrl || loginPhase !== "ready")) ||
          (method === "api" &&
            !apiKey.trim() &&
            !storedConnection &&
            !selectedKey) ||
          // The import has nothing to press until the read has answered, and the
          // card's model row is not worth choosing from before its options land.
          (importMode &&
            (importRead.status !== "ready" || !importName.trim() || importModels.isPending))
        }
        loading={busy}
        primaryIcon={opened && needsLogin ? loginPhase === "ready" ? "none" : "spinner" : undefined}
        onPrimary={() => {
          if (needsLogin) {
            if (!authorizationUrl || loginPhase !== "ready") return;
            window.open(authorizationUrl, "_blank", "noreferrer,noopener");
            setLoginPhase("waiting");
          } else void connect();
        }}
      />
      </>}
    </div>
  );
}
