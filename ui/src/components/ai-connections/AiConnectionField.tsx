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
  onModelSelect,
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
  /**
   * Called with the model an import was confirmed with, for the surface to put
   * in the agent's own model field. An agent whose stored model predates the
   * gateway would keep running on it, and a gateway that does not serve that
   * model rejects every run.
   */
  onModelSelect?: (model: string) => void;
  environmentId?: string;
  legacy?: boolean;
  readOnly?: boolean;
  preferAdvanced?: boolean;
  routerAdapterType?: string;
}) {
  const provider = aiProviderForAdapter(adapterType);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [advancedSetup, setAdvancedSetup] = useState(false);
  const [reconnecting, setReconnecting] = useState<AiManagedConnectionSummary>();
  const [allAgents, setAllAgents] = useState(true);
  const [savedAccount, setSavedAccount] = useState<{ connectionId: string; grantId: string; method: AiAuthMethod; model?: string }>();
  const [pendingAdoption, setPendingAdoption] = useState<AiRuntimeConnectionBinding>();
  /** The model an import confirmed, held until the binding it came with is accepted. */
  const [pendingAdoptionModel, setPendingAdoptionModel] = useState<string>();
  const changeBinding = (next: AiRuntimeConnectionBinding, model?: string) => {
    // The model travels with the binding it was imported for: a legacy agent
    // confirms the binding in a second dialog, and cancelling that dialog must
    // leave the agent's model as it was, not running on a model its kept
    // credentials do not support.
    if (legacy && !value) { if (!connecting) returnFocus.current = document.activeElement as HTMLElement; setPendingAdoption(next); setPendingAdoptionModel(model); }
    else { onChange(next); if (model) onModelSelect?.(model); }
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
      changeBinding({ provider: provider!, method: result.method, mode: "responsible_user" }, result.model);
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
          This connection does not support the current harness and model. Choose
          a compatible connection before saving.
        </p>
      )}
      {(compatiblePools.length > 0 || value?.mode === "router") && <label className="block space-y-1 text-sm">
        AI connection
        <select className="block w-full rounded-md border bg-background px-3 py-2" disabled={readOnly} value={value?.mode === "router" ? value.connectionId : ""} onChange={event => {
          if (event.target.value) changeBinding({ mode: "router", connectionId: event.target.value });
          else changeBinding({ mode: "responsible_user", provider, method });
        }}>
          <option value="">Individual account</option>
          {compatiblePools.map(pool => <option key={pool.id} value={pool.id}>{pool.name} · Experimental pool</option>)}
          {value?.mode === "router" && !compatiblePools.some(pool => pool.id === value.connectionId) && <option value={value.connectionId}>Pool unavailable — enable routing and the pool</option>}
        </select>
        {value?.mode === "router" && <span className="text-muted-foreground">New tasks rotate. Existing tasks keep their account.</span>}
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
          if (!open) { setPendingAdoption(undefined); setPendingAdoptionModel(undefined); }
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{pendingAdoption?.mode === "router" ? `Use ${accounts.data?.pools?.find(pool => pool.id === pendingAdoption.connectionId)?.name ?? "this pool"}?` : `Adopt Connections for ${agentName}`}</DialogTitle>
            <DialogDescription>
              {pendingAdoption?.mode === "router" ? "Reset existing sessions that use an account outside this pool." : "Saving validates access to the selected connection. Existing sessions keep their account or require an explicit reset before adoption."}
            </DialogDescription>
          </DialogHeader>
          {pendingAdoption?.mode !== "router" && <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? `Responsible user’s default. For you: ${accounts.data?.connections.find((account) => account.isDefault && account.provider === provider)?.name ?? "Not connected"}. Other users use their own default.`
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>}
          {pendingAdoption?.mode !== "router" && <p className="text-xs text-muted-foreground">
            After adoption, missing credentials block execution. Previous
            authentication will not be used as a fallback.
          </p>}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setPendingAdoption(undefined); setPendingAdoptionModel(undefined); }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                // The model lands with the binding it was imported for: the
                // adoption is the moment the agent commits to this account, so
                // it is also the moment it commits to that account's model.
                if (pendingAdoptionModel) onModelSelect?.(pendingAdoptionModel);
                setPendingAdoption(undefined);
                setPendingAdoptionModel(undefined);
              }}
            >
              {pendingAdoption?.mode === "router" ? "Use pool" : "Use this binding when saved"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={(open) => { if (!selectDefault.isPending) setConnecting(open); }}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{reconnecting ? "Reconnect account" : "Connect account"}</DialogTitle>
            <DialogDescription>
              {advancedSetup ? "Choose a provider connection for this agent." : reconnecting ? "Sign in again to repair your current default account. Its agent access stays the same." : "This account will become your default for this provider. Your tasks will use it; other users keep their own default."}
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
            // An imported connection was made from this machine's Claude config, so
            // re-importing it is how it gets repaired. Pinning the method here would
            // hide the mode switch and leave the operator no way back to it; the
            // api_key method is unchanged either way, so only a switch to a
            // subscription starts a different account.
            fixedMethod={Boolean(reconnecting?.baseUrl === undefined && reconnecting)}
            connectionId={reconnecting?.id}
            name={reconnecting?.name ?? `My ${provider === "anthropic" ? "Claude" : provider === "openai" ? "OpenAI" : provider === "xai" ? "Grok" : provider === "google" ? "Gemini" : "OpenRouter"} ${method === "subscription" ? "subscription" : "API"}`}
            ownership="personal"
            agentIds={agentId ? [agentId] : []}
            allAgents={allAgents}
            environmentId={environmentId}
            onCancel={() => setConnecting(false)}
            onComplete={(result) => {
              // The model rides with the account until the binding that uses it
              // is accepted, so a cancelled adoption leaves the agent's model
              // untouched.
              setSavedAccount({ ...result, model: result.model });
              selectDefault.mutate(result);
            }}
          />}
          {!reconnecting && !savedAccount && <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Advanced providers</summary>
            <Button type="button" variant="ghost" onClick={() => setAdvancedSetup(true)}>Choose another provider or gateway</Button>
          </details>}
          </>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
