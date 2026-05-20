import { Link } from "@/lib/router";
import type { Issue } from "@paperclipai/shared";
import { redactSecretLikeText } from "./secret-redact";
import { useMissionTelemetry, type MissionTelemetry } from "./command-center/mission-telemetry";

// LET-503 (LET-502 contract §5) — clean Dashboard. The previous landing
// opened with a paragraph of operator-briefing copy, a posture chip
// cluster, a stub "Loop state preview" card, and an in-page zone rail
// duplicating the left navigation. None of that survived the design
// correction. The new layout shows only:
//   - a compact 5-tile mission/agent posture strip backed by live reads,
//   - a "Needs attention" row (blocked + in review, scoped to the active
//     company) — the answer to "what needs me right now?",
//   - a short "Recently completed" list when present.
//
// Empty/error/missing-scope states still appear, but as a single contextual
// note inside the affected card rather than a global banner. Data-source
// disclosures move to tile tooltips (`title` attribute) per contract §4.

export interface CommandCenterLandingProps {
  // Test injection: override the telemetry hook so jsdom suites don't have
  // to wire query providers + network mocks. Production paths never pass
  // this — the default is the real hook.
  readonly telemetryHook?: () => MissionTelemetry;
}

export function CommandCenterLanding({ telemetryHook = useMissionTelemetry }: CommandCenterLandingProps = {}) {
  const telemetry = telemetryHook();

  return (
    <section
      aria-labelledby="eaos-command-center-title"
      className="flex min-h-0 flex-1 flex-col gap-5"
      data-testid="eaos-command-center-landing"
      data-eaos-data-connected={telemetry.companyScoped ? "true" : "false"}
    >
      <DashboardHeader />

      <PostureTiles telemetry={telemetry} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <NeedsAttention telemetry={telemetry} />
        <RecentlyCompleted telemetry={telemetry} />
      </div>
    </section>
  );
}

function DashboardHeader() {
  return (
    <header
      className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-3"
      data-testid="eaos-command-center-header"
    >
      <h1
        id="eaos-command-center-title"
        className="text-xl font-semibold tracking-tight text-foreground"
      >
        Dashboard
      </h1>
    </header>
  );
}

interface PostureTile {
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
  readonly hint: string;
  readonly tone: "neutral" | "active" | "warning" | "review" | "success";
  readonly target: string;
}

function PostureTiles({ telemetry }: { telemetry: MissionTelemetry }) {
  const placeholder = !telemetry.companyScoped
    ? "·"
    : telemetry.isLoading
      ? "—"
      : telemetry.isError
        ? "!"
        : null;

  const value = (n: number): number | string => (placeholder !== null ? placeholder : n);

  const tiles: PostureTile[] = [
    {
      id: "active",
      label: "Active missions",
      value: value(telemetry.counts.active),
      hint: "Issues in_progress for the current company scope.",
      tone: "active",
      target: "/eaos/missions",
    },
    {
      id: "attention",
      label: "Needs attention",
      value: value(telemetry.criticalAttention),
      hint: "Blocked or in-review missions awaiting a decision.",
      tone: "warning",
      target: "/eaos/missions",
    },
    {
      id: "in-review",
      label: "In review",
      value: value(telemetry.counts.inReview),
      hint: "Awaiting reviewer / QA decision.",
      tone: "review",
      target: "/eaos/approvals",
    },
    {
      id: "agents-active",
      label: "Agents active",
      value: value(telemetry.agents.active),
      hint: `${telemetry.agents.executing} reporting executing · ${telemetry.agents.total} total`,
      tone: "neutral",
      target: "/eaos/agents",
    },
    {
      id: "done",
      label: "Recently done",
      value: value(telemetry.counts.done),
      hint: "Missions closed in the current scope.",
      tone: "success",
      target: "/eaos/missions",
    },
  ];

  return (
    <ul
      role="list"
      aria-label="Mission and agent posture"
      data-testid="eaos-command-center-telemetry"
      data-eaos-data-connected={telemetry.companyScoped ? "true" : "false"}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5"
    >
      {tiles.map((tile) => (
        <li
          key={tile.id}
          data-testid={`eaos-command-center-telemetry-${tile.id}`}
          data-eaos-telemetry-tone={tile.tone}
          className="flex flex-col gap-1 rounded-md border border-border bg-card p-3"
        >
          <Link
            to={tile.target}
            aria-label={`${tile.label} — open ${tile.target}`}
            title={tile.hint}
            className="flex flex-col gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {tile.label}
              </span>
              <span
                aria-hidden="true"
                data-eaos-telemetry-dot={tile.tone}
                className={
                  "h-1.5 w-1.5 rounded-full " +
                  (tile.tone === "warning"
                    ? "bg-amber-500"
                    : tile.tone === "review"
                      ? "bg-violet-500"
                      : tile.tone === "active"
                        ? "bg-blue-500"
                        : tile.tone === "success"
                          ? "bg-green-500"
                          : "bg-zinc-400")
                }
              />
            </div>
            <span
              aria-label={`${tile.label}: ${tile.value}`}
              data-testid={`eaos-command-center-telemetry-${tile.id}-value`}
              className="text-2xl font-semibold tracking-tight text-foreground tabular-nums"
            >
              {tile.value}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NeedsAttention({ telemetry }: { telemetry: MissionTelemetry }) {
  return (
    <section
      aria-labelledby="eaos-command-center-attention-title"
      data-testid="eaos-command-center-activity"
      className="flex min-h-0 flex-col gap-2 rounded-md border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2
          id="eaos-command-center-attention-title"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Needs attention
        </h2>
        <Link
          to="/eaos/missions"
          className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-command-center-open-missions"
        >
          All missions →
        </Link>
      </header>

      {telemetry.isError ? (
        <ContextNote
          tone="error"
          testId="eaos-command-center-activity-error"
          body="Activity feed is temporarily unavailable. Try refreshing."
        />
      ) : !telemetry.companyScoped ? (
        <ContextNote
          testId="eaos-command-center-activity-no-company"
          body="Select a company scope in the top bar to load mission activity."
        />
      ) : telemetry.isLoading ? (
        <ContextNote
          testId="eaos-command-center-activity-loading"
          body="Loading missions…"
        />
      ) : telemetry.recent.length === 0 ? (
        <ContextNote
          testId="eaos-command-center-activity-empty"
          body="No active missions in this scope right now."
        />
      ) : (
        <ul aria-label="Active missions" className="flex flex-col">
          {telemetry.recent.map((issue, index) => (
            <ActivityRow key={issue.id} issue={issue} isLast={index === telemetry.recent.length - 1} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentlyCompleted({ telemetry }: { telemetry: MissionTelemetry }) {
  if (telemetry.recentlyCompleted.length === 0) return <RecentlyCompletedEmpty telemetry={telemetry} />;

  return (
    <section
      aria-labelledby="eaos-command-center-completed-title"
      data-testid="eaos-command-center-activity-completed"
      className="flex min-h-0 flex-col gap-2 rounded-md border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2
          id="eaos-command-center-completed-title"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Recently completed
        </h2>
        <Link
          to="/eaos/runs"
          className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          All runs →
        </Link>
      </header>
      <ul aria-label="Recently completed missions" className="flex flex-col">
        {telemetry.recentlyCompleted.map((issue, index) => (
          <ActivityRow
            key={issue.id}
            issue={issue}
            isLast={index === telemetry.recentlyCompleted.length - 1}
            compact
          />
        ))}
      </ul>
    </section>
  );
}

function RecentlyCompletedEmpty({ telemetry }: { telemetry: MissionTelemetry }) {
  return (
    <section
      aria-labelledby="eaos-command-center-completed-title"
      data-testid="eaos-command-center-activity-completed-empty"
      className="flex min-h-0 flex-col gap-2 rounded-md border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2
          id="eaos-command-center-completed-title"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Recently completed
        </h2>
      </header>
      <ContextNote
        body={
          !telemetry.companyScoped
            ? "Select a company scope to see recent completions."
            : "Nothing closed yet in this scope."
        }
      />
    </section>
  );
}

function ContextNote({
  body,
  tone = "muted",
  testId,
}: {
  body: string;
  tone?: "muted" | "error";
  testId?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      data-testid={testId}
      className={
        "px-3 py-2 text-xs " +
        (tone === "error" ? "text-foreground" : "text-muted-foreground")
      }
    >
      {body}
    </p>
  );
}

function statusLabel(status: Issue["status"]): { label: string; tone: string } {
  switch (status) {
    case "in_review":
      return {
        label: "In review",
        tone: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-600 dark:bg-violet-950 dark:text-violet-100",
      };
    case "blocked":
      return {
        label: "Blocked",
        tone: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100",
      };
    case "done":
      return {
        label: "Done",
        tone: "border-green-300 bg-green-50 text-green-800 dark:border-green-600 dark:bg-green-950 dark:text-green-100",
      };
    case "in_progress":
      return {
        label: "In progress",
        tone: "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-600 dark:bg-blue-950 dark:text-blue-100",
      };
    case "todo":
      return {
        label: "Todo",
        tone: "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300",
      };
    case "backlog":
    default:
      return {
        label: "Backlog",
        tone: "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200",
      };
  }
}

function attentionReason(issue: Issue): string | null {
  switch (issue.status) {
    case "in_review":
      return "Awaiting review";
    case "blocked": {
      const count = issue.blockedBy?.length ?? 0;
      if (count > 0) return `Blocked by ${count} dependency${count === 1 ? "" : "s"}`;
      return "Blocked";
    }
    case "in_progress":
      return null;
    case "todo":
    case "backlog":
      return "Queued";
    case "done":
    case "cancelled":
      return null;
    default:
      return null;
  }
}

function ActivityRow({
  issue,
  isLast,
  compact = false,
}: {
  issue: Issue;
  isLast: boolean;
  compact?: boolean;
}) {
  const chip = statusLabel(issue.status);
  const missionRef = issue.identifier ?? issue.id;
  const safeTitle = redactSecretLikeText(issue.title);
  const reason = compact ? null : attentionReason(issue);
  return (
    <li
      data-testid={`eaos-command-center-activity-row-${issue.id}`}
      data-eaos-activity-status={issue.status}
      className={
        "flex items-center gap-2 px-3 text-xs " +
        (compact ? "py-1.5 opacity-90" : "py-2") +
        (isLast ? "" : " border-b border-border")
      }
    >
      {issue.identifier ? (
        <span
          aria-label={`Mission identifier ${issue.identifier}`}
          className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {issue.identifier}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <Link
          to={`/eaos/missions/${missionRef}`}
          className="block truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          title={safeTitle}
        >
          {safeTitle}
        </Link>
        {reason ? (
          <span
            data-testid={`eaos-command-center-activity-row-${issue.id}-reason`}
            className="block truncate text-[11px] text-muted-foreground"
          >
            {reason}
          </span>
        ) : null}
      </div>
      <span
        className={
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
          chip.tone
        }
        title={chip.label}
      >
        {chip.label}
      </span>
    </li>
  );
}
