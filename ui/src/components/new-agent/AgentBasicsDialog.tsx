import { useCompany } from "@/context/CompanyContext";
import { useAgentAppearanceDraft } from "@/hooks/useAgentAppearanceDraft";
import { AdapterMark } from "../AdapterMark";
import { AgentCharacter } from "../AgentCharacter";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: (basics: AgentBasics) => void;
  initialAdapter?: string;
  onInvite?: () => void;
}) {
  const id = useId();
  const cloud = Boolean(useCloudInstance());
  const experimental = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: instanceSettingsApi.getExperimental,
    enabled: open,
    retry: false,
  });
  const [name, setName] = useState("");
  const [adapterType, setAdapterType] = useState(initialAdapter);
  const managedHarness = ["claude_managed", "aws_agentcore", "openai_dot"].includes(adapterType);
  const runnerProvider = managedHarness ? adapterType : "";
  const [step, setStep] = useState<"name" | "adapter">("name");
  const {
    data: adapters,
    isPending,
    error,
  } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: adaptersApi.list,
    enabled: open,
  });
  const choices = (adapters ?? []).filter(
    (adapter) =>
      adapter.type !== "paperclip_runner" &&
      adapter.loaded &&
      !adapter.disabled &&
      isNewAgentAdapterAllowed(adapter.type, {
        cloud,
        nativeRunnerEnabled: experimental.data?.enableNativeRunner === true,
      }) &&
      !["process", "http"].includes(adapter.type) &&
      !getAdapterDisplay(adapter.type).comingSoon,
  );
  const managedAvailable = !cloud && adapters?.some(adapter => adapter.type === "paperclip_runner" && adapter.loaded && !adapter.disabled);
  const dotAvailable = managedAvailable && isNewAgentAdapterAllowed("openai_dot", {
    cloud,
    nativeRunnerEnabled: false,
    openAiDotEnabled: experimental.data?.enableOpenAiDot === true,
  });
  const validAdapter = choices.some((adapter) => adapter.type === adapterType)
    || (managedAvailable && managedHarness && (adapterType !== "openai_dot" || dotAvailable));
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
            2. Harness
          </span>
        </div>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            if (step === "name") setStep("adapter");
            else if (validAdapter)
              onContinue({ name: name.trim(), adapterType: managedHarness ? "paperclip_runner" : adapterType, runnerProvider });
          }}
        >
          <div className="flex min-h-0 flex-col gap-7 overflow-y-auto px-6 pb-8 sm:px-10">
            <div className="flex flex-col items-center gap-4 text-center">
              {open && <AgentBasicsCharacter />}
              <div className="space-y-2">
                <DialogTitle className="text-3xl font-semibold tracking-tight">
                  {step === "name"
                    ? "Meet your next agent"
                    : "Choose a harness"}
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
                <legend className="sr-only">Harness</legend>
                {isPending && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading harnesses…
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
                          {adapterType === adapter.type && (
                            <Check className="absolute right-2 top-2 size-3.5" />
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {managedAvailable && <details className="space-y-3">
                  <summary className="cursor-pointer text-sm text-muted-foreground">Advanced</summary>
                  <label className="flex flex-col gap-2 text-sm">Managed harness
                    <SelectPopover
                      aria-label="Managed harness"
                      value={managedHarness ? adapterType : ""}
                      onValueChange={setAdapterType}
                      options={[
                        { value: "", label: "Choose a managed harness…" },
                        { value: "claude_managed", label: "Claude Managed" },
                        { value: "aws_agentcore", label: "AWS AgentCore" },
                        ...(dotAvailable ? [{ value: "openai_dot", label: "OpenAI Dot (experimental)" }] : []),
                      ]}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">{adapterType === "openai_dot" ? "Create the agent, then pair your Dot." : "Requires a qualified organization profile."}</p>
                </details>}
              </fieldset>
            )}
          </div>
          <div className="flex justify-between gap-4 border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="ghost"
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
              disabled={!name.trim() || (step === "adapter" && !validAdapter)}
            >
              {step === "name" ? "Choose harness" : "Configure agent"}
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
