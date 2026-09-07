import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { storeProviderApiKey } from "@/lib/provider-credential";
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
  const [method, setMethod] = useState<"subscription" | "api">("subscription");
  const [opened, setOpened] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedConnection, setStoredConnection] =
    useState<ProviderConnection | null>(null);
  const provider = adapterType === "claude_local" ? "Claude" : "OpenAI";
  const envKey =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
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
          ? (storedConnection ?? {
              env: {
                [envKey]: await storeProviderApiKey(companyId, envKey, apiKey),
              },
            })
          : {
              env: {},
              ...(adapterType === "claude_local" &&
              canLogin &&
              auth.data?.status === "present"
                ? {
                    env: buildFixedClaudeOAuthBinding(),
                    applyStoredClaudeLogin: true,
                  }
                : {}),
            };
      if (run !== epoch.current) return;
      if (method === "api") {
        setApiKey("");
        setStoredConnection(connection);
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
    auth.data?.status !== "present";
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
                onCancel={cancel}
                instruction={`Provide your ${provider} API key to connect`}
              >
                <OnboardingCardField
                  label="API key"
                  masked
                  autoFocus
                  value={apiKey}
                  placeholder={
                    storedConnection
                      ? "Key saved. Retry the connection."
                      : "Enter API key here"
                  }
                  onChange={(value) => {
                    setApiKey(value);
                    setStoredConnection(null);
                  }}
                  onSubmit={() => void connect()}
                  disabled={busy}
                />
              </OnboardingLoginCard>
            ) : needsLogin ? (
              <AdapterLoginPanel
                companyId={companyId}
                adapterType={adapterType}
                environmentId={environmentId}
                chrome="onboarding"
                autoStart
                onCancel={cancel}
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
            ) : (
              <p className="text-sm text-muted-foreground">
                {canLogin
                  ? "Use the subscription already connected to this environment."
                  : `Use the ${provider} login on this machine. If you haven’t signed in yet, run ${adapterType === "claude_local" ? "claude auth login" : "codex login"} in your terminal, then connect.`}
              </p>
            )}
          </div>
        )}
      </motion.div>
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
        primaryLabel={busy ? "Connecting" : "Connect"}
        primaryDisabled={
          auth.isPending ||
          !opened ||
          Boolean(needsLogin) ||
          (method === "api" && !apiKey.trim() && !storedConnection)
        }
        loading={busy}
        onPrimary={() => void connect()}
      />
    </div>
  );
}
