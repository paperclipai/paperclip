import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  SavedProviderKeySelect,
  useSavedProviderKeys,
} from "../onboarding/SavedProviderKeySelect";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { AdapterLoginPanel } from "../AgentConfigForm";
import {
  OnboardingCardField,
  OnboardingLoginCard,
} from "../AdapterLoginChrome";
import { ModelSourceTiles } from "../onboarding/ModelSourceTiles";
import { CredentialModeLink } from "../onboarding/CredentialModeLink";
import { FooterNav } from "../onboarding/FooterNav";
import { MAKE_ROOM, CARD_ENTER } from "../onboarding/onboarding-motion";
import { buildFixedClaudeOAuthBinding } from "../environment-variables-editor/model";
import type { EnvBinding } from "@paperclipai/shared";

export type ProviderConnection = {
  env: Record<string, EnvBinding>;
  /** Kept in memory until the user finishes setup. */
  credentials?: Record<string, string>;
  storedSessionId?: string;
  applyStoredClaudeLogin?: boolean;
};
export function AgentProviderConnection({
  companyId,
  adapterType,
  environmentId,
  canLogin,
  onConnected,
  onBack,
  testConnection,
  testError,
}: {
  companyId: string;
  adapterType: "claude_local" | "codex_local";
  environmentId: string | null;
  canLogin: boolean;
  onConnected: (connection: ProviderConnection) => void;
  onBack: () => void;
  testConnection: (connection: ProviderConnection) => Promise<boolean>;
  testError?: string | null;
}) {
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
  };
  const [methodChoice, setMethod] = useState<"subscription" | "api" | null>(null);
  const [opened, setOpened] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedConnection, setStoredConnection] =
    useState<ProviderConnection | null>(null);
  const provider = adapterType === "claude_local" ? "Claude" : "OpenAI";
  const envKey =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const savedKeys = useSavedProviderKeys(companyId, envKey);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const savedSubscription =
    adapterType === "codex_local"
      ? savedKeys.subscriptions.find(
          (option) =>
            option.id === (subscriptionId ?? savedKeys.subscriptions[0]?.id),
        )
      : undefined;
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const selectedKey = savedKeys.options.find(
    (option) => option.id === (selectedKeyId ?? savedKeys.options[0]?.id),
  );
  const storedLogin = savedKeys.storedLogin;
  const method = methodChoice ?? (
    (adapterType === "claude_local" ? storedLogin.data : savedKeys.subscriptions.length)
      ? "subscription" : savedKeys.options.length ? "api" : "subscription"
  );
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
  });
  async function connect() {
    if (busy) return;
    const run = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const connection =
        method === "api"
          ? selectedKey
            ? { env: { [envKey]: selectedKey.binding } }
            : (storedConnection ?? {
                env: {},
                credentials: { [envKey]: apiKey.trim() },
              })
          : {
              env: savedSubscription
                ? { CODEX_HOME: savedSubscription.binding }
                : {},
              ...(adapterType === "claude_local" && storedLogin.data
                ? {
                    env: buildFixedClaudeOAuthBinding(),
                    applyStoredClaudeLogin: true,
                  }
                : {}),
            };
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
    (auth.data?.status !== "present" || subscriptionId === "");
  return (
    <div>
      <ModelSourceTiles
        label="Connect your model provider"
        sources={[
          {
            id: adapterType,
            label: provider,
            icon: (
              <img
                src={`/brands/${adapterType === "claude_local" ? "claude" : "codex"}-color.svg`}
                className="size-6"
                alt=""
              />
            ),
          },
        ]}
        mode={method}
        selectedId={opened ? adapterType : null}
        collapsed={opened}
        onSelect={() => setOpened(true)}
      />
      {!opened && (
        <div className="-ml-3 mt-1">
          <CredentialModeLink
            mode={method}
            onChange={(next) => {
              setMethod(next);
              setError(null);
            }}
          />
        </div>
      )}
      {!opened && savedKeys.options.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {savedKeys.options.length} saved API{" "}
          {savedKeys.options.length === 1 ? "key available" : "keys available"}.
        </p>
      )}
      {method === "subscription" &&
        adapterType === "codex_local" &&
        savedKeys.subscriptions.length > 0 && (
          <SavedProviderKeySelect
            options={savedKeys.subscriptions}
            value={savedSubscription?.id ?? ""}
            onChange={setSubscriptionId}
            loading={false}
            error={false}
            kind="subscription"
            disabled={busy}
          />
        )}
      <motion.div
        initial={false}
        animate={{ height: opened ? "auto" : 0, opacity: opened ? 1 : 0 }}
        transition={{ height: MAKE_ROOM, opacity: CARD_ENTER }}
        className="overflow-hidden"
      >
        {opened && (
          <div className="pt-5">
            {method === "api" ? (
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
                autoStart
                onStored={(storedSessionId) => {
                  const connection = {
                    env: buildFixedClaudeOAuthBinding(),
                    storedSessionId,
                  };
                  setStoredConnection(connection);
                  onConnected(connection);
                }}
                onConnected={() => {
                  if (adapterType === "codex_local") onConnected({ env: {} });
                }}
              />
            ) : savedSubscription ? null : (
              <p className="text-sm text-muted-foreground">
                {storedLogin.data
                  ? "Use your saved Claude subscription for this agent."
                  : canLogin
                    ? "Use the existing provider connection for this environment."
                    : `Use the ${provider} login on this machine. If you haven’t signed in yet, run ${adapterType === "claude_local" ? "claude auth login" : "codex login"} in your terminal, then connect.`}
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
      <FooterNav
        onBack={() => {
          if (opened) cancel();
          else onBack();
        }}
        primaryLabel={
          busy
            ? "Connecting"
            : method === "subscription" &&
                (storedLogin.data || savedSubscription)
              ? "Use saved subscription"
              : method === "api" && selectedKey
                ? "Use saved API key"
                : "Connect"
        }
        primaryDisabled={
          auth.isPending ||
          savedKeys.loading ||
          (adapterType === "claude_local" && storedLogin.isPending) ||
          !opened ||
          Boolean(needsLogin) ||
          (method === "api" &&
            !apiKey.trim() &&
            !storedConnection &&
            !selectedKey)
        }
        loading={busy}
        onPrimary={() => void connect()}
      />
    </div>
  );
}
