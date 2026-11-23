import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_SETUP_PROGRESS_LIMITS } from "@paperclipai/shared";
import type {
  AgentSetupProgress,
  AgentSetupProgressHandoff,
  AgentSetupProgressItemStatus,
  CreateAgentSetupProgress,
} from "@paperclipai/shared";
import { agentSetupProgressApi } from "@/api/agentSetupProgress";
import { useAccountIdentity } from "@/api/companies-query";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "@/components/StatusIcon";
import { timeAgo } from "@/lib/timeAgo";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { agentSetupHandoffStorageKey, storeAgentSetupHandoff, storedAgentSetupHandoff } from "@/lib/agent-setup-handoff-storage";

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
 * Creates one checklist for this setup and follows it. The checklist is kept
 * per company, purpose and subject, so leaving the step and coming back keeps
 * following the checklist the copied prompt writes to. `renew` makes a fresh
 * one, for an expired prompt or after a failed request.
 */
export function useAgentSetupProgress({
  companyId,
  purpose,
  subjectId,
  enabled = true,
  client = agentSetupProgressApiClient,
  accountId: accountOverride,
}: CreateAgentSetupProgress & {
  companyId: string | null | undefined;
  enabled?: boolean;
  client?: AgentSetupProgressClient;
  /** The signed-in account; stories and tests pass it, the app reads the session. */
  accountId?: string;
}) {
  const queryClient = useQueryClient();
  // The checklist belongs to the person setting up: keyed by account so another account never reuses it.
  const account = useAccountIdentity();
  const accountId = accountOverride ?? account.userId ?? "anonymous";
  // Current, not merely settled: right after an in-place sign-in the cached session still names the
  // previous account, and this tab may hold that account's checklist token.
  const accountKnown = Boolean(accountOverride) || account.current;
  const accountFailed = !accountOverride && account.failed;
  const handoffKey = ["agent-setup-progress-handoff", accountId, companyId ?? null, purpose, subjectId ?? null] as const;
  const storageKey = agentSetupHandoffStorageKey(accountId, companyId, purpose, subjectId);
  const handoffQuery = useQuery({
    queryKey: handoffKey,
    queryFn: async () => {
      // A handoff found in this tab's storage came from an earlier visit; a created one is new.
      const stored = storedAgentSetupHandoff(storageKey);
      const handoff = stored ?? await client.create(companyId!, { purpose, ...(subjectId ? { subjectId } : {}) });
      storeAgentSetupHandoff(storageKey, handoff);
      return { handoff, fromEarlierVisit: Boolean(stored) };
    },
    enabled: Boolean(companyId) && enabled && accountKnown,
    // Created once per setup: never re-created on its own (renew does that). A failed create
    // follows the app's retry defaults; at worst a retry leaves an unused checklist that expires.
    staleTime: Infinity,
    gcTime: AGENT_SETUP_PROGRESS_LIMITS.lifetimeMs,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const handoff = handoffQuery.data?.handoff ?? null;

  const progressId = handoff?.progress.id ?? null;
  const query = useQuery({
    queryKey: queryKeys.agentSetupProgress(progressId),
    queryFn: () => client.get(progressId!),
    enabled: Boolean(progressId),
    initialData: handoff?.progress,
    refetchInterval: (current) => {
      const data = current.state.data;
      if (!data || data.status === "done" || data.status === "failed") return false;
      return Date.parse(data.expiresAt) > Date.now() ? SAFETY_REFETCH_MS : false;
    },
  });
  const progress = query.data ?? handoff?.progress ?? null;
  const finished = progress?.status === "done" || progress?.status === "failed";
  const expired = Boolean(progress && !finished && Date.parse(progress.expiresAt) <= Date.now());
  const renew = () => {
    // A failed sign-in lookup is retried first; the checklist follows once it answers.
    if (accountFailed) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      return;
    }
    storeAgentSetupHandoff(storageKey, null);
    void handoffQuery.refetch();
  };

  // A finished checklist takes no more updates, so it is never handed to another attempt: a reload
  // stops reusing it, and opening the step again later (such as a reconnect) starts a fresh one.
  useEffect(() => {
    if (finished) storeAgentSetupHandoff(storageKey, null);
  }, [finished, storageKey]);
  // Only a checklist from an earlier visit is replaced: one this page created that finishes while it is
  // open stays on screen. "Earlier" means found in storage, or cached before this step opened. It is
  // decided once per account-specific key, so a session that arrives late is judged on its own key.
  const openedAt = useRef(Date.now());
  const checkedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!handoffQuery.data || !query.isFetched || checkedKey.current === storageKey) return;
    checkedKey.current = storageKey;
    const fromEarlier = handoffQuery.data.fromEarlierVisit || handoffQuery.dataUpdatedAt < openedAt.current;
    if (fromEarlier && finished) renew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffQuery.data, handoffQuery.dataUpdatedAt, query.isFetched, storageKey, finished]);

  return {
    handoff,
    progress,
    expired,
    error: handoffQuery.error
      ? describeError(handoffQuery.error).body
      : accountFailed ? "Paperclip couldn’t confirm who is signed in." : null,
    /** A refresh of the checklist failed; the last one stays on screen. */
    refreshError: query.error && progress ? describeError(query.error).body : null,
    retryRefresh: () => { void query.refetch(); },
    renew,
  };
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
  /** The prompt's token stopped working before the agent finished. */
  expired?: boolean;
  /** Makes a fresh checklist (and prompt), after it expired or a failed attempt. */
  onRenew?: () => void;
  /** Why the latest refresh failed; the last checklist stays on screen. */
  refreshError?: string | null;
  onRetryRefresh?: () => void;
  /** What the agent is setting up, in a few words, such as "AWS". */
  subject: string;
  className?: string;
}

/** The live checklist. Before the agent reports anything, it says what to do and waits. */
export function AgentSetupProgressPanel({
  progress, subject, expired = false, onRenew, refreshError = null, onRetryRefresh, className,
}: AgentSetupProgressPanelProps) {
  const headingId = useId();
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
      aria-labelledby={headingId}
      aria-live="polite"
      data-testid="agent-setup-progress"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-medium text-foreground">
          {expired ? "This setup prompt expired" : heading}
        </h3>
        <p className={cn("text-sm text-muted-foreground", ANALYTICS_MASK_CLASS)}>
          {expired
            ? "Its progress link stopped working before your agent finished. Start again for a new prompt, then give it to your agent."
            : status === "waiting"
            ? "Paste the prompt into your agent. Its steps appear here as it works."
            : progress?.summary ?? (status === "done" ? "Every step is done." : "Keep your agent running; its steps update here.")}
        </p>
      </div>

      {items.length > 0 ? (
        // Agent-written text (titles, details, the summary) can name accounts and roles: never in session recordings.
        <ol className={cn("divide-y divide-border rounded-md border border-border", ANALYTICS_MASK_CLASS)}>
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
      {refreshError ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
          Couldn’t refresh your agent’s progress: {refreshError}
          {onRetryRefresh ? <Button type="button" variant="outline" size="sm" onClick={onRetryRefresh}>Retry</Button> : null}
        </p>
      ) : null}
      {(expired || status === "failed") && onRenew ? (
        <div className="space-y-1">
          {status === "failed" && !expired ? (
            <p className="text-xs text-muted-foreground">Fix what stopped it, then start again for a new prompt.</p>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={onRenew}>Start again</Button>
        </div>
      ) : null}
    </section>
  );
}
