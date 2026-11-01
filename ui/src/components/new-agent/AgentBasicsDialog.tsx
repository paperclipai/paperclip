import { useCompany } from "@/context/CompanyContext";
import { PAPERCLIP_RUNNER_ACPX_PROFILES } from "@paperclipai/adapter-utils";
import { useAgentAppearanceDraft } from "@/hooks/useAgentAppearanceDraft";
import { AdapterMark } from "../AdapterMark";
import { AgentCharacter } from "../AgentCharacter";
import { useEffect, useId, useRef, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { buildNewAgentRuntimeConfig } from "@/lib/new-agent-runtime-config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ChevronRight } from "lucide-react";
import { adaptersApi } from "@/api/adapters";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { isNewAgentAdapterAllowed } from "@/lib/new-agent-adapters";
import { queryKeys } from "@/lib/queryKeys";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SelectPopover } from "../ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";

export type AgentBasics = {
  name: string;
  adapterType: string;
  runnerProvider: string;
  runner: string;
  setupAgentId: string;
};
export { AdapterMark } from "../AdapterMark";

function AgentBasicsCharacter() {
  const { selectedCompanyId } = useCompany();
  const { appearance } = useAgentAppearanceDraft(`${selectedCompanyId}:new-agent`);
  return <AgentCharacter appearance={appearance} state="sleepy" muted size={256} className="size-48" trackingScope="page" />;
}

export function AgentBasicsDialog({
  open,
  onClose,
  onContinue,
  initialAdapter = "",
  initialName = "",
  setupAgentId,
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: (basics: AgentBasics) => void;
  initialAdapter?: string;
  initialName?: string;
  setupAgentId?: string;
  onInvite?: () => void;
}) {
  const id = useId();
  const { selectedCompanyId: companyId } = useCompany();
  const cache = useQueryClient();
  const appearanceDraft = useAgentAppearanceDraft(`${companyId}:new-agent`);
  const setupId = useRef(setupAgentId ?? crypto.randomUUID());
  const saved = useRef<Agent | null>(null);
  const busy = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cloud = Boolean(useCloudInstance());
  const experimental = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: instanceSettingsApi.getExperimental,
    enabled: open,
    retry: false,
  });
  const [name, setName] = useState(initialName);
  const [adapterType, setAdapterType] = useState(initialAdapter);
  const [runnerProvider, setRunnerProvider] = useState("codex");
  const [step, setStep] = useState<"name" | "adapter">(setupAgentId ? "adapter" : "name");
  const {
    data: adapters,
    isPending,
    error,
  } = useQuery({
    queryKey: queryKeys.adapters.availability(companyId ?? "none", null),
    queryFn: () => adaptersApi.list({ companyId: companyId! }),
    enabled: open && Boolean(companyId),
  });
  const nativeRunner = adapters?.find(adapter => adapter.type === "paperclip_runner" && adapter.loaded && !adapter.disabled);
  const copilotAvailable = Boolean(nativeRunner) && PAPERCLIP_RUNNER_ACPX_PROFILES.some(profile => profile.value === "copilot" && profile.qualified);
  const kimiAvailable = Boolean(nativeRunner) && experimental.data?.enableNativeRunner === true
    && PAPERCLIP_RUNNER_ACPX_PROFILES.some(profile => profile.value === "kimi" && profile.qualified);
  const antigravityQualified = PAPERCLIP_RUNNER_ACPX_PROFILES.some(profile => profile.value === "antigravity" && profile.qualified);
  const antigravityCandidate = nativeRunner?.candidateHarnesses?.some(candidate => candidate.agent === "antigravity");
  const antigravityAvailable = Boolean(nativeRunner);
  const choices = [...(adapters ?? []).filter(
    (adapter) =>
      adapter.loaded &&
      !adapter.disabled &&
      adapter.type !== "paperclip_runner" &&
      isNewAgentAdapterAllowed(adapter.type, {
        cloud,
        nativeRunnerEnabled: experimental.data?.enableNativeRunner === true,
      }) &&
      !["process", "http"].includes(adapter.type) &&
      !getAdapterDisplay(adapter.type).comingSoon,
  ), ...(copilotAvailable ? [{ ...nativeRunner!, type: "copilot_runtime" }] : []),
    ...(antigravityAvailable ? [{ ...nativeRunner!, type: "antigravity_runtime" }] : []),
    ...(kimiAvailable ? [{ ...nativeRunner!, type: "kimi_runtime" }] : [])];
  const experimentalRunnerAvailable = experimental.data?.enableNativeRunner === true
    && adapters?.some(adapter => adapter.type === "paperclip_runner" && adapter.loaded && !adapter.disabled);
  const validAdapter = choices.some((adapter) => adapter.type === adapterType)
    || (experimentalRunnerAvailable && adapterType === "paperclip_runner" && (runnerProvider !== "antigravity" || antigravityQualified));
  async function submit() {
    if (busy.current || !name.trim() || (step === "adapter" && !validAdapter)) return;
    busy.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      if (!companyId) throw new Error("Select an organization to create an agent.");
      let agent = saved.current;
      if (!agent && setupAgentId) agent = await agentsApi.get(setupId.current, companyId);
      const creatingRecord = !agent;
      if (!agent) {
        const existing = (await agentsApi.list(companyId)).filter(item => item.id !== setupId.current);
        const leader = existing.find(item => item.role === "ceo" && item.status !== "terminated");
        const provisionalAdapter = adapters?.some(item => item.type === "process" && item.disabled)
          ? choices[0]?.type : "process";
        if (!provisionalAdapter) throw new Error("No agent adapters are available on this instance.");
        // This adapter is provisional; the setup hold prevents execution.
        agent = await agentsApi.create(companyId, {
          setupId: setupId.current, name: name.trim(), appearance: appearanceDraft.appearance,
          role: existing.length ? "general" : "ceo", ...(leader ? { reportsTo: leader.id } : {}),
          adapterType: ["copilot_runtime", "antigravity_runtime", "kimi_runtime"].includes(provisionalAdapter) ? "paperclip_runner" : provisionalAdapter,
          ...(["copilot_runtime", "antigravity_runtime", "kimi_runtime"].includes(provisionalAdapter) ? { adapterConfig: { provider: "acpx", acpxAgent: provisionalAdapter === "copilot_runtime" ? "copilot" : provisionalAdapter === "kimi_runtime" ? "kimi" : "antigravity" } } : {}),
          metadata: { setupAdapterPending: true },
          runtimeConfig: buildNewAgentRuntimeConfig({ heartbeatEnabled: false }),
        });
        if (active.current) setName(agent.name);
      }
      saved.current = agent;
      const nextAdapter = ["openai_dot", "copilot_runtime", "antigravity_runtime", "kimi_runtime"].includes(adapterType) ? "paperclip_runner" : adapterType;
      const nextProvider = adapterType === "kimi_runtime" ? "kimi" : adapterType === "antigravity_runtime" ? "antigravity" : adapterType === "copilot_runtime" ? "copilot" : adapterType === "openai_dot" ? "openai_dot" : adapterType === "paperclip_runner" ? runnerProvider : "codex";
      // Pending providers can show setup while the saved name-only draft stays held.
      const pendingAntigravity = nextProvider === "antigravity" && !antigravityQualified;
      if (step === "adapter" || (!creatingRecord && agent.name !== name.trim())) {
        const { setupAdapterChoice: _previousChoice, ...metadata } = agent.metadata ?? {};
        agent = await agentsApi.update(agent.id, {
          name: name.trim(),
          ...(step === "adapter" && pendingAntigravity ? {
            metadata: { ...metadata, setupAdapterPending: true,
              setupAdapterChoice: { adapterType: nextAdapter, runnerProvider: nextProvider, runner: "auto" } },
          } : {}),
          ...(step === "adapter" && !pendingAntigravity ? {
            adapterType: nextAdapter, runner: "auto" as const,
            adapterConfig: nextAdapter === "paperclip_runner" ? {
              provider: ["claude", "grok", "copilot", "antigravity", "kimi"].includes(nextProvider) ? "acpx" : nextProvider,
              ...(["claude", "grok", "copilot", "antigravity", "kimi"].includes(nextProvider) ? { acpxAgent: nextProvider } : {}),
              ...(nextProvider === "grok" ? { model: "grok-4.7" } : {}),
            } : {},
            metadata: { ...metadata, setupAdapterPending: false },
          } : {}),
        }, companyId);
        saved.current = agent;
      }
      cache.setQueryData(queryKeys.agents.detail(agent.id), agent);
      void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      if (!active.current) return;
      if (step === "name") setStep("adapter");
      else onContinue({ name: agent.name, adapterType: nextAdapter, runnerProvider: nextProvider,
        runner: "auto", setupAgentId: agent.id });
    } catch (cause) {
      if (active.current) setSaveError(cause instanceof Error ? cause.message : "Could not save agent setup.");
    } finally {
      busy.current = false;
      if (active.current) setSaving(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-(--sz-640px)",
          step === "name" && "sm:max-w-(--sz-560px)",
        )}
      >
        <div
          className="flex items-center gap-2 px-6 py-5 text-xs text-muted-foreground"
          aria-label="New agent progress"
        >
          <span
            className={cn(step === "name" && "font-medium text-foreground")}
          >
            1. Name
          </span>
          <ChevronRight className="size-3" />
          <span
            className={cn(step === "adapter" && "font-medium text-foreground")}
          >
            2. Adapter
          </span>
        </div>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex min-h-0 flex-col gap-7 overflow-y-auto px-6 pb-8 sm:px-10">
            <div className="flex flex-col items-center gap-4 text-center">
              {open && <AgentBasicsCharacter />}
              <div className="space-y-2">
                <DialogTitle className="text-3xl font-semibold tracking-tight">
                  {step === "name"
                    ? "Meet your next agent"
                    : "Choose an adapter"}
                </DialogTitle>
                <DialogDescription className="text-base">
                  {step === "name"
                    ? "Start with a name. Make them your own."
                    : `How should ${name.trim()} work?`}
                </DialogDescription>
              </div>
            </div>
            {step === "name" ? (
              <div className="space-y-2">
                <label htmlFor={id} className="text-sm font-medium">
                  Agent name
                </label>
                <Input
                  id={id}
                  autoFocus
                  disabled={saving}
                  maxLength={100}
                  placeholder="e.g. Darnold"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 text-base"
                />
                {onInvite && (
                  <Button
                    type="button"
                    variant="link"
                    className="px-0 text-muted-foreground"
                    onClick={onInvite}
                  >
                    Invite an external agent
                  </Button>
                )}
              </div>
            ) : (
              <fieldset className="space-y-4">
                <legend className="sr-only">Adapter</legend>
                {isPending && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading adapters…
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error.message}
                  </p>
                )}
                <div className={cn("grid grid-cols-2 gap-3", choices.length !== 4 && "sm:grid-cols-3")}>
                  {choices.map((adapter) => {
                    const display = getAdapterDisplay(adapter.type);
                    return (
                      <label
                        key={adapter.type}
                        className="relative cursor-pointer"
                      >
                        <input
                          type="radio"
                          disabled={saving}
                          name="new-agent-adapter"
                          value={adapter.type}
                          checked={adapterType === adapter.type}
                          onChange={() => setAdapterType(adapter.type)}
                          className="peer sr-only"
                        />
                        <span
                          className={cn(
                            "flex h-full flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center peer-focus-visible:ring-2 peer-focus-visible:ring-ring hover:bg-accent/40",
                            adapterType === adapter.type
                              ? "border-foreground/40 bg-accent"
                              : "border-border bg-card",
                          )}
                        >
                          <AdapterMark type={adapter.type} />
                          <span className="text-sm font-medium">
                            {display.label}
                          </span>
                          {adapter.type === "antigravity_runtime" && !antigravityQualified && (
                            <span className="text-xs text-muted-foreground">{antigravityCandidate ? "Candidate" : "Not available yet"}</span>
                          )}
                          {adapterType === adapter.type && (
                            <Check className="absolute right-2 top-2 size-3.5" />
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {experimentalRunnerAvailable && <details className="space-y-3">
                  <summary className="cursor-pointer text-sm text-muted-foreground">Advanced</summary>
                  <div className="space-y-2">
                    <label className="text-sm text-muted-foreground">Experimental harness</label>
                    <SelectPopover aria-label="Experimental harness"
                      value={adapterType === "paperclip_runner" ? runnerProvider : ""}
                      placeholder="Choose a native harness…"
                      onValueChange={provider => { setRunnerProvider(provider); setAdapterType("paperclip_runner"); }}
                      options={[
                        { value: "grok", label: "Grok Build (Paperclip Runner)" },
                        { value: "opencode", label: "OpenCode (Paperclip Runner)" },
                      ]} />
                  </div>
                </details>}
              </fieldset>
            )}
          </div>
          {saveError && <p role="alert" className="px-6 pb-4 text-sm text-destructive">{saveError}</p>}
          <div className="flex justify-between gap-4 border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => (step === "name" ? onClose() : setStep("name"))}
            >
              {step === "name" ? (
                "Cancel"
              ) : (
                <>
                  <ArrowLeft className="size-4" />
                  Back
                </>
              )}
            </Button>
            <Button
              type="submit"
              disabled={saving || !name.trim() || (step === "adapter" && !validAdapter)}
            >
              {saving ? "Saving…" : step === "name" ? "Choose adapter" : "Configure agent"}
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
