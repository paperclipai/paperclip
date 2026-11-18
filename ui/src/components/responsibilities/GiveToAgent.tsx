import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { Bot } from "lucide-react";
import { describeError } from "@/api/errors";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { routinesApi } from "@/api/routines";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { queryKeys } from "@/lib/queryKeys";
import type { GivableItem } from "@/lib/responsibilities";

/**
 * Hand one project, task or routine to an agent, with the app's existing
 * calls: a task is assigned (`PATCH /issues/:id` with `assigneeAgentId`), a
 * routine is assigned (`PATCH /routines/:id` with `assigneeAgentId`), and a
 * project gets the agent as its lead (`PATCH /projects/:id` with `leadAgentId`).
 */
export function giveItemToAgent(companyId: string, item: Pick<GivableItem, "kind" | "id">, agentId: string): Promise<unknown> {
  switch (item.kind) {
    case "task":
      return issuesApi.update(item.id, { assigneeAgentId: agentId, assigneeUserId: null });
    case "routine":
      return routinesApi.update(item.id, { assigneeAgentId: agentId });
    case "project":
      return projectsApi.update(item.id, { leadAgentId: agentId }, companyId);
  }
}

/** The give-to-agent mutation, refreshing responsibilities and the item's own lists. */
export function useGiveToAgent(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ item, agentId }: { item: GivableItem; agentId: string }) => giveItemToAgent(companyId, item, agentId),
    onSuccess: (_result, { item }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
      if (item.kind === "task") void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      if (item.kind === "routine") void queryClient.invalidateQueries({ queryKey: ["routines", companyId] });
      if (item.kind === "project") void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
    },
  });
}

/**
 * "Give to an agent" for one project, task or routine: a menu of the
 * company's agents, the current one checked. Says in place who has it now,
 * or why it could not be given.
 */
export function GiveToAgentMenu({
  companyId,
  item,
  agents,
  size = "xs",
  variant = "ghost",
}: {
  companyId: string;
  item: GivableItem;
  agents: readonly Agent[];
  size?: "xs" | "icon-xs";
  /** `outline` where the hand-off is the row's main action (the "Needs you" queue). */
  variant?: "ghost" | "outline";
}) {
  const give = useGiveToAgent(companyId);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const choices = useMemo(
    () => agents.filter((agent) => agent.status !== "terminated").slice().sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );
  const noun = item.kind === "project" ? "project" : item.kind === "routine" ? "routine" : "task";
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {result ? (
        <span role={result.ok ? "status" : "alert"} className={result.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {result.text}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size={size}
            variant={variant}
            className={variant === "ghost" ? "text-muted-foreground" : undefined}
            disabled={give.isPending}
            aria-label={`Give ${item.label} to an agent`}
            title={size === "icon-xs" ? "Give to an agent" : undefined}
          >
            <Bot aria-hidden="true" />
            {size === "xs" ? "Give to an agent" : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-(--sz-50vh) overflow-y-auto">
          <DropdownMenuLabel>
            {item.kind === "project" ? "Who leads this project" : `Who takes this ${noun}`}
          </DropdownMenuLabel>
          {choices.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet. Add an agent first.</p>
          ) : (
            <DropdownMenuRadioGroup
              value={item.currentAgentId ?? ""}
              onValueChange={(agentId) => {
                if (!agentId || agentId === item.currentAgentId) return;
                const name = choices.find((agent) => agent.id === agentId)?.name ?? "the agent";
                setResult(null);
                give.mutate({ item, agentId }, {
                  onSuccess: () => setResult({ ok: true, text: item.kind === "project" ? `${name} leads it now.` : `${name} has it now.` }),
                  onError: (error) => setResult({ ok: false, text: `Couldn’t give it to ${name}. ${describeError(error).body}` }),
                });
              }}
            >
              {choices.map((agent) => (
                <DropdownMenuRadioItem key={agent.id} value={agent.id}>{agent.name}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
