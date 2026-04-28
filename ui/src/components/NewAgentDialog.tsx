import { useState, useMemo, useDeferredValue } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { adaptersApi } from "../api/adapters";
import { blueprintsApi, type AgentBlueprint } from "../api/blueprints";
import { queryKeys } from "@/lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Bot,
  Layers,
  Search,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { listUIAdapters } from "../adapters";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

/**
 * Adapter types that are suitable for agent creation (excludes internal
 * system adapters like "process" and "http").
 */
const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);

function isAgentAdapterType(type: string): boolean {
  return !SYSTEM_ADAPTER_TYPES.has(type);
}

type Step = "main" | "adapter-pick" | "blueprint-pick" | "blueprint-action";

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("main");
  const [selectedBlueprint, setSelectedBlueprint] = useState<AgentBlueprint | null>(null);
  const [blueprintSearch, setBlueprintSearch] = useState("");
  const deferredBlueprintSearch = useDeferredValue(blueprintSearch);
  const disabledTypes = useDisabledAdaptersSync();

  function reset() {
    setStep("main");
    setSelectedBlueprint(null);
    setBlueprintSearch("");
  }

  // Fetch registered adapters from server (syncs disabled store + provides data)
  const { data: serverAdapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  // Fetch existing agents for the "Ask CEO" flow
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  // Fetch blueprints when on picker step
  const { data: blueprints } = useQuery({
    queryKey: queryKeys.blueprints.list(deferredBlueprintSearch || undefined),
    queryFn: () => blueprintsApi.list({ search: deferredBlueprintSearch || undefined }),
    enabled: newAgentOpen && (step === "blueprint-pick" || step === "blueprint-action"),
  });

  const ceoAgent = (agents ?? []).find((a) => a.role === "ceo");

  // Build the adapter grid from the UI registry merged with display metadata.
  const adapterGrid = useMemo(() => {
    const registered = listUIAdapters()
      .filter((a) => isAgentAdapterType(a.type) && !disabledTypes.has(a.type));

    return registered
      .map((a) => {
        const display = getAdapterDisplay(a.type);
        return {
          value: a.type,
          label: display.label,
          desc: display.description,
          icon: display.icon,
          recommended: display.recommended,
          comingSoon: display.comingSoon,
          disabledLabel: display.disabledLabel,
        };
      })
      .sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [disabledTypes, serverAdapters]);

  function handleAskCeo() {
    closeNewAgent();
    reset();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: "Create a new agent",
      description: "(type in what kind of agent you want here)",
    });
  }

  function handleAskCeoWithBlueprint(bp: AgentBlueprint) {
    closeNewAgent();
    reset();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: `Hire a new agent from blueprint: ${bp.name}`,
      description: [
        `Please hire a new agent using the **${bp.name}** blueprint as a starting point.`,
        "",
        `**Blueprint ID:** \`${bp.id}\``,
        `**Role:** ${AGENT_ROLE_LABELS[bp.role as keyof typeof AGENT_ROLE_LABELS] ?? bp.role}`,
        bp.description ? `**Description:** ${bp.description}` : "",
        bp.capabilities ? `**Base capabilities:** ${bp.capabilities}` : "",
        bp.tags.length > 0 ? `**Tags:** ${bp.tags.join(", ")}` : "",
        "",
        "Adapt the blueprint for this organization's specific needs (stack, cwd, model, prompt context) before submitting the hire request.",
        "",
        `Use the \`paperclip-blueprints\` skill to fetch the full config for blueprint \`${bp.id}\`.`,
      ].filter(Boolean).join("\n"),
    });
  }

  function handleManualFromBlueprint(bp: AgentBlueprint) {
    closeNewAgent();
    reset();
    navigate(`/agents/new?blueprintId=${encodeURIComponent(bp.id)}`);
  }

  function handleAdvancedAdapterPick(adapterType: string) {
    closeNewAgent();
    reset();
    navigate(`/agents/new?adapterType=${encodeURIComponent(adapterType)}`);
  }

  const filteredBlueprints = blueprints ?? [];

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md p-0 gap-0 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2">
            {step !== "main" && (
              <button
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  if (step === "blueprint-action") setStep("blueprint-pick");
                  else setStep("main");
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <span className="text-sm text-muted-foreground">Add a new agent</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => { reset(); closeNewAgent(); }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-5">
          {/* ── Main step ─────────────────────────────────────────────── */}
          {step === "main" && (
            <>
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Bot className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  We recommend letting your CEO handle agent setup — they know the
                  org structure and can configure reporting, permissions, and
                  adapters.
                </p>
              </div>

              <Button className="w-full" size="lg" onClick={handleAskCeo}>
                <Bot className="h-4 w-4 mr-2" />
                Ask the CEO to create a new agent
              </Button>

              {/* From Blueprint */}
              <button
                className="w-full flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-left text-sm transition-colors hover:bg-accent/50"
                onClick={() => setStep("blueprint-pick")}
              >
                <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <span className="font-medium text-foreground">Start from a Blueprint</span>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Pick a saved configuration template, then ask the CEO to adapt it or configure manually.
                  </p>
                </div>
              </button>

              {/* Advanced link */}
              <div className="text-center">
                <button
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                  onClick={() => setStep("adapter-pick")}
                >
                  I want advanced configuration myself
                </button>
              </div>
            </>
          )}

          {/* ── Adapter pick step ─────────────────────────────────────── */}
          {step === "adapter-pick" && (
            <>
              <p className="text-sm text-muted-foreground">
                Choose your adapter type for advanced setup.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {adapterGrid.map((opt) => (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs transition-colors hover:bg-accent/50 relative",
                      opt.comingSoon && "opacity-40 cursor-not-allowed",
                    )}
                    disabled={!!opt.comingSoon}
                    title={opt.comingSoon ? opt.disabledLabel : undefined}
                    onClick={() => {
                      if (!opt.comingSoon) handleAdvancedAdapterPick(opt.value);
                    }}
                  >
                    {opt.recommended && (
                      <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                        Recommended
                      </span>
                    )}
                    <opt.icon className="h-4 w-4" />
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ── Blueprint pick step ───────────────────────────────────── */}
          {step === "blueprint-pick" && (
            <>
              <p className="text-sm text-muted-foreground">
                Pick a blueprint to use as a starting point.
              </p>

              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search blueprints…"
                  value={blueprintSearch}
                  onChange={(e) => setBlueprintSearch(e.target.value)}
                />
              </div>

              <div className="max-h-64 overflow-y-auto space-y-1.5 -mx-1 px-1">
                {filteredBlueprints.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {blueprintSearch ? "No blueprints match your search." : "No blueprints yet."}
                  </p>
                ) : (
                  filteredBlueprints.map((bp) => (
                    <button
                      key={bp.id}
                      className="w-full flex items-start gap-3 rounded-md border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
                      onClick={() => { setSelectedBlueprint(bp); setStep("blueprint-action"); }}
                    >
                      <Layers className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{bp.name}</span>
                          <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
                            {AGENT_ROLE_LABELS[bp.role as keyof typeof AGENT_ROLE_LABELS] ?? bp.role}
                          </span>
                        </div>
                        {bp.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{bp.description}</p>
                        )}
                        {bp.tags.length > 0 && (
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {bp.tags.slice(0, 3).map((t) => (
                              <span key={t} className="rounded bg-accent/60 px-1 py-0.5 text-[10px] text-muted-foreground">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          {/* ── Blueprint action step ─────────────────────────────────── */}
          {step === "blueprint-action" && selectedBlueprint && (
            <>
              {/* Selected blueprint summary */}
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium">{selectedBlueprint.name}</span>
                  <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {AGENT_ROLE_LABELS[selectedBlueprint.role as keyof typeof AGENT_ROLE_LABELS] ?? selectedBlueprint.role}
                  </span>
                </div>
                {selectedBlueprint.description && (
                  <p className="text-xs text-muted-foreground ml-6">{selectedBlueprint.description}</p>
                )}
                {selectedBlueprint.tags.length > 0 && (
                  <div className="flex gap-1 ml-6 flex-wrap">
                    {selectedBlueprint.tags.map((t) => (
                      <span key={t} className="rounded bg-accent/60 px-1 py-0.5 text-[10px] text-muted-foreground">{t}</span>
                    ))}
                  </div>
                )}
              </div>

              <p className="text-sm text-muted-foreground">How do you want to proceed?</p>

              {/* Ask CEO */}
              <button
                className="w-full flex items-start gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/50"
                onClick={() => handleAskCeoWithBlueprint(selectedBlueprint)}
              >
                <Bot className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">Ask the CEO to adapt this blueprint</span>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Opens an issue assigned to the CEO with the blueprint as context. The CEO will customize it for this org's stack and hire the agent.
                  </p>
                </div>
              </button>

              {/* Manual */}
              <button
                className="w-full flex items-start gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/50"
                onClick={() => handleManualFromBlueprint(selectedBlueprint)}
              >
                <Shield className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">Configure manually</span>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Opens the hire form pre-filled with the blueprint's config. You tweak everything before submitting.
                  </p>
                </div>
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
