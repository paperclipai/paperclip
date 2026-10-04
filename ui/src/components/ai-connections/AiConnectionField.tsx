import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiAuthMethod,
  type AiProvider,
  type AiManagedConnectionSummary,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  const provider = aiProviderForAdapter(adapterType);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [pendingAdoption, setPendingAdoption] = useState<AiConnectionBinding>();
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState<AiManagedConnectionSummary>();
  const [allAgents, setAllAgents] = useState(true);
  const [savedAccount, setSavedAccount] = useState<{ connectionId: string; grantId: string; method: AiAuthMethod }>();
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
  const personalDefault = accounts.data?.connections.find((account) => account.provider === provider && account.isDefault && account.ownership === "personal" && account.ownerUserId === accounts.data.currentUserId);
  const selectDefault = useMutation({
    mutationFn: async (result: NonNullable<typeof savedAccount>) => {
      // Reconnect retains the existing default and its access. A new account
      // must be selected explicitly before a responsible-user binding uses it.
      if (!reconnecting) await aiConnectionsApi.setDefault(companyId, result.grantId);
      return result;
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["ai-connections", companyId] });
      changeBinding({ provider: provider!, method: result.method, mode: "responsible_user" });
      setConnecting(false);
    },
  });
  const openConnection = (reconnect?: AiManagedConnectionSummary) => {
    returnFocus.current = document.activeElement as HTMLElement;
    setReconnecting(reconnect);
    setAllAgents(accounts.data?.canManageConnections ?? false);
    setSavedAccount(undefined);
    selectDefault.reset();
    setConnecting(true);
  };
  const method: AiAuthMethod = (value?.mode !== "responsible_user" ? value?.method : undefined)
    ?? accounts.data?.connections.find((account) => account.provider === provider && account.isDefault)?.method
    ?? (provider === "openrouter" ? "api_key" : "subscription");
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
          This connection does not support the current harness and model. Choose
          a compatible connection before saving.
        </p>
      )}
      <AiConnectionPicker
        requirement={{ companyId, provider }}
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
        onConnect={() => openConnection()}
        onReconnect={(!value || value.mode === "responsible_user") && personalDefault && personalDefault.status !== "connected" ? () => openConnection(personalDefault) : undefined}
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
            <DialogTitle>Adopt Connections for {agentName}</DialogTitle>
            <DialogDescription>
              Saving tests this account in {agentName}’s environment before
              replacing its existing authentication. Other agents keep their
              current configuration.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? `Responsible user’s default. For you: ${accounts.data?.connections.find((account) => account.isDefault && account.provider === provider)?.name ?? "Not connected"}. Other users use their own default.`
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>
          <p className="text-xs text-muted-foreground">
            After adoption, missing credentials block execution. Previous
            authentication will not be used as a fallback.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingAdoption(undefined)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                setPendingAdoption(undefined);
              }}
            >
              Use this binding when saved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={(open) => { if (!selectDefault.isPending) setConnecting(open); }}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{reconnecting ? "Reconnect account" : "Connect account"}</DialogTitle>
            <DialogDescription>
              {reconnecting ? "Sign in again to repair your current default account. Its agent access stays the same." : "This account will become your default for this provider. Your tasks will use it; other users keep their own default."}
            </DialogDescription>
          </DialogHeader>
          {!reconnecting && !savedAccount && <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={allAgents} onCheckedChange={(checked) => setAllAgents(checked === true)} />
            Allow all agents in this company to use this account for my tasks
          </label>}
          {savedAccount ? <div className="space-y-4">
            {selectDefault.error ? <>
              <p role="alert" className="text-sm text-destructive">{selectDefault.error.message}</p>
              <Button onClick={() => selectDefault.mutate(savedAccount)}>Retry default selection</Button>
            </> : <p role="status" className="text-sm text-muted-foreground">Selecting your default account…</p>}
          </div> :
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider}
            initialMethod={reconnecting?.method ?? method}
            fixedMethod={Boolean(reconnecting)}
            connectionId={reconnecting?.id}
            name={reconnecting?.name ?? `My ${provider === "anthropic" ? "Claude" : provider === "openai" ? "OpenAI" : provider === "xai" ? "Grok" : "OpenRouter"} ${method === "subscription" ? "subscription" : "API"}`}
            ownership="personal"
            agentIds={agentId ? [agentId] : []}
            allAgents={allAgents}
            environmentId={environmentId}
            onCancel={() => setConnecting(false)}
            onComplete={(result) => {
              setSavedAccount(result);
              selectDefault.mutate(result);
            }}
          />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
