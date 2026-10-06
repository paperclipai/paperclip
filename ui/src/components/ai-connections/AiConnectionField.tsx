import { useTranslation, t } from "@/i18n";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiRuntimeConnectionBinding,
  type AiAuthMethod,
  type AiConnectionBinding,
  type AiProvider,
  type AiManagedConnectionSummary,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionSelect } from "./AiConnectionSelect";
import { AiProviderSetup } from "./AiProviderSetup";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
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
      gemini_local: "google",
      hermes_local: "openrouter",
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
  preferAdvanced = false,
  routerAdapterType,
}: {
  companyId: string;
  agentId?: string;
  agentName: string;
  adapterType: string;
  model?: string;
  value?: AiRuntimeConnectionBinding;
  onChange: (binding: AiRuntimeConnectionBinding) => void;
  environmentId?: string;
  legacy?: boolean;
  readOnly?: boolean;
  preferAdvanced?: boolean;
  routerAdapterType?: string;
}) {
  const { t } = useTranslation();
  const provider = aiProviderForAdapter(adapterType);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [pendingAdoption, setPendingAdoption] = useState<AiRuntimeConnectionBinding>();
  const [connecting, setConnecting] = useState(false);
  const [advancedSetup, setAdvancedSetup] = useState(false);
  const [reconnecting, setReconnecting] = useState<AiManagedConnectionSummary>();
  const [allAgents, setAllAgents] = useState(true);
  const [savedAccount, setSavedAccount] = useState<{ connectionId: string; grantId: string; method: AiAuthMethod }>();
  const changeBinding = (next: AiRuntimeConnectionBinding) => {
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
    setAdvancedSetup(!reconnect && (preferAdvanced || provider === "openrouter"));
    setAllAgents(accounts.data?.canManageConnections ?? false);
    setSavedAccount(undefined);
    selectDefault.reset();
    setConnecting(true);
  };
  const method: AiAuthMethod = (value && value.mode !== "router" && value.mode !== "responsible_user" ? value.method : undefined)
    ?? accounts.data?.connections.find((account) => account.provider === provider && account.isDefault)?.method
    ?? (provider === "openrouter" || provider === "google" ? "api_key" : "subscription");
  const compatiblePools = agentId ? accounts.data?.pools?.filter(pool => pool.enabled && pool.members.some(member => isAiConnectionCompatible(member.binding, routerAdapterType ?? adapterType, member.profile.model, member.profile.provider, member.profile.acpxAgent))) ?? [] : [];
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
      {value && value.mode !== "router" && (adapterType !== "opencode_local" || Boolean(model)) && !isAiConnectionCompatible(value, adapterType, model) && (
        <p role="alert" className="text-sm text-destructive">
          {t("sep13Connections.harnessIncompatible")}
        </p>
      )}
      {(compatiblePools.length > 0 || value?.mode === "router") && <label className="block space-y-1 text-sm">
        {t("sep13Connections.aiConnection")}
        <select className="block w-full rounded-md border bg-background px-3 py-2" disabled={readOnly} value={value?.mode === "router" ? value.connectionId : ""} onChange={event => {
          if (event.target.value) changeBinding({ mode: "router", connectionId: event.target.value });
          else changeBinding({ mode: "responsible_user", provider, method });
        }}>
          <option value="">{t("oct6Beta.copy027")}</option>
          {compatiblePools.map(pool => <option key={pool.id} value={pool.id}>{t("oct6Beta.poolCaption", { name: pool.name })}</option>)}
          {value?.mode === "router" && !compatiblePools.some(pool => pool.id === value.connectionId) && <option value={value.connectionId}>{t("oct6Beta.copy028")}</option>}
        </select>
        {value?.mode === "router" && <span className="text-muted-foreground">{t("oct6Beta.copy029")}</span>}
      </label>}
      {value?.mode !== "router" && <AiConnectionSelect
        adapterType={adapterType}
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
      />}
      <Dialog
        open={Boolean(pendingAdoption)}
        onOpenChange={(open) => {
          if (!open) setPendingAdoption(undefined);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{pendingAdoption?.mode === "router" ? t("oct6Beta.dynamic048", { v0: accounts.data?.pools?.find(pool => pool.id === pendingAdoption.connectionId)?.name ?? t("oct6Beta.thisPool") }) : t("oct6Beta.dynamic049", { v0: agentName })}</DialogTitle>
            <DialogDescription>
              {pendingAdoption?.mode === "router" ? t("oct6Beta.copy030") : t("oct6Beta.copy031")}
            </DialogDescription>
          </DialogHeader>
          {pendingAdoption?.mode !== "router" && <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? t("sep13Connections.responsibleDefaultDescription", { connection: accounts.data?.connections.find((account) => account.isDefault && account.provider === provider)?.name ?? t("sep13Connections.notConnected") })
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>}
          {pendingAdoption?.mode !== "router" && <p className="text-xs text-muted-foreground">
            {t("sep13Connections.adoptWarning")}
          </p>}
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
              {pendingAdoption?.mode === "router" ? t("oct6Beta.copy032") : t("sep13Connections.useBindingWhenSaved")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={(open) => { if (!selectDefault.isPending) setConnecting(open); }}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{reconnecting ? t("sep13Connections.reconnectAccount") : t("sep13Connections.connectAccount")}</DialogTitle>
            <DialogDescription>
              {advancedSetup ? t("oct6Beta.copy033") : reconnecting ? t("oct5Apps.copy002") : t("oct5Apps.copy003")}
            </DialogDescription>
          </DialogHeader>
          {advancedSetup ? <AiProviderSetup
            companyId={companyId} agentId={agentId} environmentId={environmentId}
            advancedOnly={preferAdvanced}
            initialProtocol={adapterType === "claude_local" ? "messages" : adapterType === "codex_local" ? "responses" : "chat"}
            onCancel={() => preferAdvanced ? setConnecting(false) : setAdvancedSetup(false)}
            onComplete={binding => {
              void client.invalidateQueries({ queryKey: ["ai-connections", companyId] });
              setConnecting(false);
              changeBinding(binding);
            }}
          /> : <>
          {!reconnecting && !savedAccount && <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={allAgents} disabled={!accounts.data?.canManageConnections} onCheckedChange={(checked) => setAllAgents(checked === true)} />
            {t("oct5Apps.copy004")}
          </label>}
          {savedAccount ? <div className="space-y-4">
            {selectDefault.error ? <>
              <p role="alert" className="text-sm text-destructive">{selectDefault.error.message}</p>
              <Button onClick={() => selectDefault.mutate(savedAccount)}>{t("oct5Apps.copy005")}</Button>
            </> : <p role="status" className="text-sm text-muted-foreground">{t("oct5Apps.copy006")}</p>}
          </div> :
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider}
            initialMethod={reconnecting?.method ?? method}
            fixedMethod={Boolean(reconnecting)}
            connectionId={reconnecting?.id}
            name={reconnecting?.name ?? t(method === "subscription" ? "oct6Beta.accountNameSubscription" : "oct6Beta.accountNameApi", { provider: provider === "anthropic" ? "Claude" : provider === "openai" ? "OpenAI" : provider === "xai" ? "Grok" : provider === "google" ? "Gemini" : "OpenRouter" })}
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
          {!reconnecting && !savedAccount && <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">{t("oct6Beta.copy034")}</summary>
            <Button type="button" variant="ghost" onClick={() => setAdvancedSetup(true)}>{t("oct6Beta.copy035")}</Button>
          </details>}
          </>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
