import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Search } from "lucide-react";
import {
  DEFAULT_AGENT_HELP_PROMPT,
  buildAgentHelpRequestComment,
  type AgentHelpRequestAgent,
} from "../lib/agent-help-request";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type AskAgentsForHelpAgent = AgentHelpRequestAgent & {
  status?: string | null;
  title?: string | null;
  capabilities?: string | null;
};

interface AskAgentsForHelpDialogProps {
  open: boolean;
  issueTitle: string;
  agents: readonly AskAgentsForHelpAgent[];
  submitting?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (commentBody: string) => Promise<void>;
}

export function AskAgentsForHelpDialog({
  open,
  issueTitle,
  agents,
  submitting = false,
  onOpenChange,
  onSubmit,
}: AskAgentsForHelpDialogProps) {
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_AGENT_HELP_PROMPT);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPrompt(DEFAULT_AGENT_HELP_PROMPT);
    setSelectedAgentIds([]);
  }, [open]);

  const activeAgents = useMemo(
    () =>
      [...agents]
        .filter((agent) => agent.status !== "terminated")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );

  const visibleAgents = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return activeAgents;
    return activeAgents.filter((agent) => {
      const haystack = `${agent.name} ${agent.title ?? ""} ${agent.capabilities ?? ""}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [activeAgents, query]);

  const selectedAgents = useMemo(
    () => activeAgents.filter((agent) => selectedAgentIds.includes(agent.id)),
    [activeAgents, selectedAgentIds],
  );

  const canSubmit = selectedAgents.length > 0 && prompt.trim().length > 0 && !submitting;

  function toggleAgent(agentId: string) {
    setSelectedAgentIds((current) =>
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId],
    );
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    const comment = buildAgentHelpRequestComment({
      issueTitle,
      selectedAgents,
      prompt,
    });

    try {
      await onSubmit(comment);
      onOpenChange(false);
    } catch {
      // The caller owns error toasts; keep the dialog open so the request can be retried.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            Ask agents
          </DialogTitle>
          <DialogDescription>
            Ask selected agents to review this task and suggest how they can help.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-xs text-muted-foreground">Task</div>
            <div className="mt-0.5 truncate text-sm font-medium">{issueTitle}</div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="ask-agents-search">
              Agents
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="ask-agents-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search agents..."
                className="h-8 pl-7 text-sm"
              />
            </div>
            <div className="max-h-52 overflow-y-auto rounded-md border border-border">
              {visibleAgents.length > 0 ? (
                visibleAgents.map((agent) => {
                  const selected = selectedAgentIds.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={cn(
                        "flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent/50",
                        selected && "bg-accent/60",
                      )}
                      onClick={() => toggleAgent(agent.id)}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border",
                          selected && "border-primary bg-primary text-primary-foreground",
                        )}
                        aria-hidden="true"
                      >
                        {selected ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{agent.name}</span>
                        {agent.title || agent.capabilities ? (
                          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                            {agent.title ?? agent.capabilities}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No active agents found.
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="ask-agents-prompt">
              Prompt
            </label>
            <Textarea
              id="ask-agents-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              className="min-h-24 resize-y text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? "Posting..." : "Ask agents"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
