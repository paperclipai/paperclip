import { useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Bot,
  Code,
  Gem,
  MousePointer2,
  Sparkles,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";

type AdvancedAdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "openclaw_gateway";

const ADVANCED_ADAPTER_OPTIONS: Array<{
  value: AdvancedAdapterType;
  label: string;
  desc: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
}> = [
  {
    value: "claude_local",
    label: "Claude Code",
    icon: Sparkles,
    desc: "Local Claude agent",
    recommended: true,
  },
  {
    value: "codex_local",
    label: "Codex",
    icon: Code,
    desc: "Local Codex agent",
    recommended: true,
  },
  {
    value: "gemini_local",
    label: "Gemini CLI",
    icon: Gem,
    desc: "Local Gemini agent",
  },
  {
    value: "opencode_local",
    label: "OpenCode",
    icon: OpenCodeLogoIcon,
    desc: "Local multi-provider agent",
  },
  {
    value: "pi_local",
    label: "Pi",
    icon: Terminal,
    desc: "Local Pi agent",
  },
  {
    value: "cursor",
    label: "Cursor",
    icon: MousePointer2,
    desc: "Local Cursor agent",
  },
  {
    value: "openclaw_gateway",
    label: "OpenClaw Gateway",
    icon: Bot,
    desc: "Invoke OpenClaw via gateway protocol",
  },
];

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [showAdvancedCards, setShowAdvancedCards] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const ceoAgent = (agents ?? []).find((a) => a.role === "ceo");

  function handleAskCeo() {
    closeNewAgent();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: "Create a new agent",
      description: "(type in what kind of agent you want here)",
    });
  }

  function handleAdvancedConfig() {
    setShowAdvancedCards(true);
  }

  function handleAdvancedAdapterPick(adapterType: AdvancedAdapterType) {
    closeNewAgent();
    setShowAdvancedCards(false);
    navigate(`/agents/new?adapterType=${encodeURIComponent(adapterType)}`);
  }

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          setShowAdvancedCards(false);
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
          <span className="text-sm text-muted-foreground">Add a new agent</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => {
              setShowAdvancedCards(false);
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-6">
          {!showAdvancedCards ? (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Sparkles className="h-6 w-6 text-foreground" />
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

              {/* Advanced link */}
              <div className="text-center">
                <button
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                  onClick={handleAdvancedConfig}
                >
                  I want advanced configuration myself
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowAdvancedCards(false)}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <p className="text-sm text-muted-foreground">
                  Choose your adapter type for advanced setup.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {ADVANCED_ADAPTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs transition-colors hover:bg-accent/50 relative"
                    )}
                    onClick={() => handleAdvancedAdapterPick(opt.value)}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
