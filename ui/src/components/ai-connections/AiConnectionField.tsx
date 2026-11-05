import { useTranslation } from "@/i18n";
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
import { describeError } from "@/api/errors";
import { useQueryView } from "@/components/QueryView";
import { AiConnectionSelect } from "./AiConnectionSelect";
import { AiProviderSetup } from "./AiProviderSetup";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
import { aiConnectionDisplayLabel } from "./model";
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
      pi_local: "openrouter",
      grok_local: "xai",
      copilot_runtime: "github",
      antigravity_runtime: "google",
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
  const { t } = useTranslation("connections");
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
  const accountsView = useQueryView(accounts);
  const personalDefault = accounts.data?.connections.find((account) => account.provider === provider && account.isDefault && account.ownership === "personal" && account.ownerUserId === accounts.data.currentUserId);
  const pendingAccount = pendingAdoption?.mode === "responsible_user"
    ? personalDefault
    : pendingAdoption && pendingAdoption.mode !== "router"
      ? accounts.data?.connections.find(account => account.id === pendingAdoption.connectionId && account.grantId === pendingAdoption.grantId)
      : undefined;
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
    ?? (provider === "openrouter" || provider === "google" || provider === "github" ? "api_key" : "subscription");
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
      {value && value.mode !== "router" && (!["opencode_local", "pi_local"].includes(adapterType) || Boolean(model)) && !isAiConnectionCompatible(value, adapterType, model) && (
        <p role="alert" className="text-sm text-destructive">{t("this_connection_does_not_support_the_current_983471e")}</p>
      )}
      {(compatiblePools.length > 0 || value?.mode === "router") && <label className="block space-y-1 text-sm">{t("ai_connection_cc2f293")}<select className="block w-full rounded-md border bg-background px-3 py-2" disabled={readOnly} value={value?.mode === "router" ? value.connectionId : ""} onChange={event => {
          if (event.target.value) changeBinding({ mode: "router", connectionId: event.target.value });
          else changeBinding({ mode: "responsible_user", provider, method });
        }}>
          <option value="">{t("individual_account_3d77a8d")}</option>
          {compatiblePools.map(pool => <option key={pool.id} value={pool.id}>{t("experimental_pool_aba6401", { name: pool.name })}</option>)}
          {value?.mode === "router" && !compatiblePools.some(pool => pool.id === value.connectionId) && <option value={value.connectionId}>{t("pool_unavailable_enable_routing_and_the_pool_7fa426f")}</option>}
        </select>
        {value?.mode === "router" && <span className="text-muted-foreground">{t("new_tasks_rotate_existing_tasks_keep_their_94cbe2b")}</span>}
      </label>}
      {value?.mode !== "router" && <AiConnectionSelect
        adapterType={adapterType}
          model={model}
        requirement={{ companyId, provider }}
        connections={accounts.data?.connections ?? []}
        value={value}
        currentUserId={accounts.data?.currentUserId ?? ""}
        agentId={agentId ?? ""}
        agentName={agentName}
        readOnly={readOnly}
        loading={accounts.isPending || accountsView.kind === "reconnecting"}
        error={accountsView.kind === "error" ? describeError(accounts.error).body : undefined}
        onChange={(binding) =>
          changeBinding(aiConnectionBindingSchema.parse(binding))
        }
        onConnect={() => openConnection()}
        onReconnect={(!value || value.mode === "responsible_user") && personalDefault && personalDefault.status !== "connected" ? () => openConnection(personalDefault) : undefined}
        onRetry={accountsView.retry}
      />}
      <Dialog
        open={Boolean(pendingAdoption)}
        onOpenChange={(open) => {
          if (!open) setPendingAdoption(undefined);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{pendingAdoption?.mode === "router" ? t("use_4956f83", { value: accounts.data?.pools?.find(pool => pool.id === pendingAdoption.connectionId)?.name ?? t("this_pool_18e18ec") }) : t("adopt_connections_for_f9856a7", { agentName: agentName })}</DialogTitle>
            <DialogDescription>
              {pendingAdoption?.mode === "router" ? t("reset_existing_sessions_that_use_an_account_92e9bd3") : t("saving_validates_access_to_the_selected_connection_afed23d")}
            </DialogDescription>
          </DialogHeader>
          {pendingAdoption?.mode !== "router" && <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? t("responsible_user_s_default_for_you_other_c1a7540", { value: pendingAccount ? aiConnectionDisplayLabel(pendingAccount) : t("not_connected_8b02f3d") })
              : pendingAccount && aiConnectionDisplayLabel(pendingAccount)}
          </p>}
          {pendingAdoption?.mode !== "router" && <p className="text-xs text-muted-foreground">{t("after_adoption_missing_credentials_block_execution_previous_0661ebd")}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingAdoption(undefined)}
            >{t("cancel_1791a62")}</Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                setPendingAdoption(undefined);
              }}
            >
              {pendingAdoption?.mode === "router" ? t("use_pool_1bff2b5") : t("use_this_binding_when_saved_9f3e581")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={(open) => { if (!selectDefault.isPending) setConnecting(open); }}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{reconnecting ? t("reconnect_account_75e1bf0") : t("connect_account_8ff19dc")}</DialogTitle>
            <DialogDescription>
              {advancedSetup ? t("choose_a_provider_connection_for_this_agent_d895079") : reconnecting ? t("sign_in_again_to_repair_your_current_165206c") : t("this_account_will_become_your_default_for_625006d")}
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
            <Checkbox checked={allAgents} disabled={!accounts.data?.canManageConnections} onCheckedChange={(checked) => setAllAgents(checked === true)} />{t("allow_all_agents_in_this_company_to_77a7f7e")}</label>}
          {savedAccount ? <div className="space-y-4">
            {selectDefault.error ? <>
              <p role="alert" className="text-sm text-destructive">{describeError(selectDefault.error).body}</p>
              <Button onClick={() => selectDefault.mutate(savedAccount)}>{t("retry_default_selection_390b137")}</Button>
            </> : <p role="status" className="text-sm text-muted-foreground">{t("selecting_your_default_account_7bc6972")}</p>}
          </div> :
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider}
            initialMethod={reconnecting?.method ?? method}
            fixedMethod={Boolean(reconnecting)}
            connectionId={reconnecting?.id}
            name={reconnecting?.name ?? `My ${provider === "anthropic" ? "Claude" : provider === "openai" ? "OpenAI" : provider === "xai" ? "Grok" : provider === "google" ? "Gemini" : provider === "github" ? "GitHub Copilot" : "OpenRouter"} ${method === "subscription" ? "subscription" : "API"}`}
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
            <summary className="cursor-pointer text-sm text-muted-foreground">{t("advanced_providers_376152a")}</summary>
            <Button type="button" variant="ghost" onClick={() => setAdvancedSetup(true)}>{t("choose_another_provider_or_gateway_79db751")}</Button>
          </details>}
          </>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
