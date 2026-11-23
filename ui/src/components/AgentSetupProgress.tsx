import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentSetupProgress,
  AgentSetupProgressHandoff,
  AgentSetupProgressItemStatus,
  CreateAgentSetupProgress,
} from "@paperclipai/shared";
import { agentSetupProgressApi } from "@/api/agentSetupProgress";
import { describeError } from "@/api/errors";
import { StatusIcon } from "@/components/StatusIcon";
import { timeAgo } from "@/lib/timeAgo";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/**
 * Live setup progress from a person's own agent. A page that offers "Set it up
 * with your agent" creates a checklist with `useAgentSetupProgress`, appends
 * `agentSetupProgressInstructions` to its prompt, and shows
 * `AgentSetupProgressPanel`. The agent sets the checklist and ticks it off
 * with the URLs and token in the prompt; each update reaches the page live.
 */

/** The calls the hook makes. Stories and tests pass in-memory fakes. */
export interface AgentSetupProgressClient {
  create(companyId: string, input: CreateAgentSetupProgress): Promise<AgentSetupProgressHandoff>;
  get(id: string): Promise<AgentSetupProgress>;
}

export const agentSetupProgressApiClient: AgentSetupProgressClient = agentSetupProgressApi;

/** A suggested checklist step for the agent; it may add, rename or drop steps as it works. */
export interface AgentSetupStep {
  key: string;
  title: string;
}

/** While the agent is working, a slow check backs up the live updates in case the page missed one. */
const SAFETY_REFETCH_MS = 20_000;

/**
 * Creates one checklist for this setup (once per company, purpose and subject)
 * and follows it. Returns the agent's handoff for the prompt and the live checklist.
 */
export function useAgentSetupProgress({
  companyId,
  purpose,
  subjectId,
  enabled = true,
  client = agentSetupProgressApiClient,
}: CreateAgentSetupProgress & { companyId: string | null | undefined; enabled?: boolean; client?: AgentSetupProgressClient }) {
  const queryClient = useQueryClient();
  const [handoff, setHandoff] = useState<AgentSetupProgressHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef<string | null>(null);
  const requestKey = companyId && enabled ? `${companyId}:${purpose}:${subjectId ?? ""}` : null;

  useEffect(() => {
    if (!requestKey || requested.current === requestKey) return;
    requested.current = requestKey;
    setHandoff(null);
    setError(null);
    let cancelled = false;
    client.create(companyId!, { purpose, ...(subjectId ? { subjectId } : {}) }).then(
      (created) => {
        if (cancelled) return;
        queryClient.setQueryData(queryKeys.agentSetupProgress(created.progress.id), created.progress);
        setHandoff(created);
      },
      (caught) => { if (!cancelled) setError(describeError(caught).body); },
    );
    return () => {
      cancelled = true;
      requested.current = null;
    };
  }, [client, companyId, purpose, queryClient, requestKey, subjectId]);

  const progressId = handoff?.progress.id ?? null;
  const query = useQuery({
    queryKey: queryKeys.agentSetupProgress(progressId),
    queryFn: () => client.get(progressId!),
    enabled: Boolean(progressId),
    initialData: handoff?.progress,
    refetchInterval: (current) => {
      const status = current.state.data?.status;
      return status === "done" || status === "failed" ? false : SAFETY_REFETCH_MS;
    },
  });

  return { handoff, progress: query.data ?? handoff?.progress ?? null, error };
}

/**
 * The part of a setup prompt that tells the agent how to report progress.
 * `steps` are suggestions; the agent sets its own checklist.
 */
export function agentSetupProgressInstructions(handoff: AgentSetupProgressHandoff, steps: AgentSetupStep[]): string {
  const auth = `-H "Authorization: Bearer ${handoff.token}" -H "Content-Type: application/json"`;
  const checklist = JSON.stringify({ items: steps.map((step) => ({ key: step.key, title: step.title })) });
  const firstKey = steps[0]?.key ?? "step-1";
  return [
    "Report your progress to Paperclip as you work, so I can follow along on the setup page. These requests only update this setup's checklist, and they stop working after a few hours. If one fails, keep going with the setup.",
    "",
    "1. Before you start, set your checklist (one item per step; keys use lowercase letters, numbers, - and _). Change the steps if your plan differs:",
    `   curl -sS -X PUT ${handoff.urls.checklist} ${auth} -d '${checklist}'`,
    "2. When you start and finish each step, update it. status is in_progress, done or failed; detail is one short, optional sentence:",
    `   curl -sS -X POST ${handoff.urls.item.replace("{key}", firstKey)} ${auth} -d '{"status":"in_progress"}'`,
    `   (Use each step's own key in place of ${firstKey}.)`,
    "3. When everything is finished, say so, with a one-line summary (status done or failed):",
    `   curl -sS -X POST ${handoff.urls.finish} ${auth} -d '{"status":"done","summary":"…"}'`,
  ].join("\n");
}

const ITEM_GLYPH: Record<AgentSetupProgressItemStatus, string> = {
  pending: "backlog",
  in_progress: "in_progress",
  done: "done",
  failed: "blocked",
};
const ITEM_LABEL: Record<AgentSetupProgressItemStatus, string | null> = {
  pending: null,
  in_progress: "In progress",
  done: "Done",
  failed: "Failed",
};

export interface AgentSetupProgressPanelProps {
  progress: AgentSetupProgress | null;
  /** What the agent is setting up, in a few words, such as "AWS". */
  subject: string;
  className?: string;
}

/** The live checklist. Before the agent reports anything, it says what to do and waits. */
export function AgentSetupProgressPanel({ progress, subject, className }: AgentSetupProgressPanelProps) {
  const [, setTick] = useState(0);
  // Keeps "Last update …" current while the panel is open.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = progress?.items ?? [];
  const status = progress?.status ?? "waiting";
  const heading = status === "done"
    ? `Your agent set up ${subject}`
    : status === "failed"
      ? `Your agent couldn’t finish setting up ${subject}`
      : `Your agent is setting up ${subject}`;

  return (
    <section
      className={cn("space-y-3 rounded-lg border border-border p-4", className)}
      aria-labelledby="agent-setup-progress-heading"
      aria-live="polite"
      data-testid="agent-setup-progress"
    >
      <div className="space-y-1">
        <h3 id="agent-setup-progress-heading" className="text-sm font-medium text-foreground">{heading}</h3>
        <p className="text-sm text-muted-foreground">
          {status === "waiting"
            ? "Paste the prompt into your agent. Its steps appear here as it works."
            : progress?.summary ?? (status === "done" ? "Every step is done." : "Keep your agent running; its steps update here.")}
        </p>
      </div>

      {items.length > 0 ? (
        <ol className="divide-y divide-border rounded-md border border-border">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-3 px-3 py-2.5" data-status={item.status}>
              <span className="mt-0.5" aria-hidden="true"><StatusIcon status={ITEM_GLYPH[item.status]} size="sm" /></span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm", item.status === "pending" ? "text-muted-foreground" : "text-foreground")}>{item.title}</p>
                {item.detail ? <p className="break-words text-xs text-muted-foreground">{item.detail}</p> : null}
              </div>
              {ITEM_LABEL[item.status] ? (
                <span className="shrink-0 text-xs text-muted-foreground">{ITEM_LABEL[item.status]}</span>
              ) : <span className="sr-only">Not started</span>}
            </li>
          ))}
        </ol>
      ) : null}

      {progress && status !== "waiting" ? (
        <p className="text-xs text-muted-foreground">Last update {timeAgo(progress.updatedAt)}</p>
      ) : null}
    </section>
  );
}
