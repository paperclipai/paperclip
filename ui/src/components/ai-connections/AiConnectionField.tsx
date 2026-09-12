import { useTranslation } from "@/i18n";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiAuthMethod,
  type AiProvider,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function aiProviderForAdapter(
  adapterType: string,
): AiProvider | undefined {
  return (
    {
      claude_local: "anthropic",
      codex_local: "openai",
      opencode_local: "openrouter",
      grok_local: "xai",
    } as Record<string, AiProvider>
  )[adapterType];
}
export function AiConnectionField({
  companyId,
  agentId,
  agentName,
  adapterType,
  model,
  value,
  onChange,
  environmentId,
  legacy = false,
  readOnly = false,
}: {
  companyId: string;
  agentId?: string;
  agentName: string;
  adapterType: string;
  model?: string;
  value?: AiConnectionBinding;
  onChange: (binding: AiConnectionBinding) => void;
  environmentId?: string;
  legacy?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const provider = aiProviderForAdapter(adapterType);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [pendingAdoption, setPendingAdoption] = useState<AiConnectionBinding>();
  const [connecting, setConnecting] = useState(false);
  const method: AiAuthMethod =
    value?.method ?? (provider === "openrouter" ? "api_key" : "subscription");
  const changeBinding = (next: AiConnectionBinding) => {
    if (legacy && !value) { if (!connecting) returnFocus.current = document.activeElement as HTMLElement; setPendingAdoption(next); }
    else onChange(next);
  };
  const client = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
    enabled: Boolean(provider),
  });
  if (!provider) return null;
  if (legacy && !value && !adopting)
    return (
      <AiConnectionLegacyNotice
        readOnly={readOnly}
        onAdopt={() => setAdopting(true)}
      />
    );
  return (
    <div className="space-y-4">
      {value && (adapterType !== "opencode_local" || Boolean(model)) && !isAiConnectionCompatible(value, adapterType, model) && (
        <p role="alert" className="text-sm text-destructive">
          {t("sep13Connections.harnessIncompatible")}
        </p>
      )}
      <AiConnectionPicker
        requirement={{ companyId, provider, method }}
        connections={accounts.data?.connections ?? []}
        value={value}
        currentUserId={accounts.data?.currentUserId ?? ""}
        agentId={agentId ?? ""}
        agentName={agentName}
        readOnly={readOnly}
        loading={accounts.isPending}
        error={accounts.error?.message}
        onChange={(binding) =>
          changeBinding(aiConnectionBindingSchema.parse(binding))
        }
        onConnect={() => { returnFocus.current = document.activeElement as HTMLElement; setConnecting(true); }}
        onRetry={() => void accounts.refetch()}
      />
      <Dialog
        open={Boolean(pendingAdoption)}
        onOpenChange={(open) => {
          if (!open) setPendingAdoption(undefined);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{t("sep13Connections.adoptForAgent", { agent: agentName })}</DialogTitle>
            <DialogDescription>
              {t("sep13Connections.adoptDescription", { agent: agentName })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? t("sep13Connections.responsibleDefaultDescription", { connection: accounts.data?.connections.find((account) => account.isDefault && account.provider === provider && account.method === pendingAdoption.method)?.name ?? t("sep13Connections.notConnected") })
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("sep13Connections.adoptWarning")}
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingAdoption(undefined)}
            >
              {t("sep13Connections.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                setPendingAdoption(undefined);
              }}
            >
              {t("sep13Connections.useBindingWhenSaved")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{t("sep13Connections.connectAccount")}</DialogTitle>
          </DialogHeader>
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider}
            initialMethod={method}
            name={t(method === "subscription" ? "sep13Connections.defaultSubscriptionName" : "sep13Connections.defaultApiName", { provider: provider === "anthropic" ? "Claude" : provider === "openai" ? "OpenAI" : provider === "xai" ? "Grok" : "OpenRouter" })}
            ownership="personal"
            agentIds={agentId ? [agentId] : []}
            allAgents={false}
            environmentId={environmentId}
            onCancel={() => setConnecting(false)}
            onComplete={({ method: connectedMethod }) => {
              void client.invalidateQueries({
                queryKey: ["ai-connections", companyId],
              });
              setConnecting(false);
              changeBinding({ provider, method: connectedMethod, mode: "responsible_user" });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
