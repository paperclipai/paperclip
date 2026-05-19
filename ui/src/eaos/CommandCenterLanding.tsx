import { Link } from "@/lib/router";
import {
  AlertOctagon,
  ArrowUpRight,
  CircleDot,
  Compass,
  Cpu,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { EaosStateChip } from "./EaosStateChip";
import { redactSecretLikeText } from "./secret-redact";
import { useMissionTelemetry, type MissionTelemetry } from "./command-center/mission-telemetry";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
  type EaosStateLabel,
} from "./state-labels";
import { EAOS_PRIMARY_NAV_ZONES, EAOS_SECONDARY_NAV_ZONES } from "./nav-zones";

// LET-484 — Hyperagents/Multica-style Command Center landing. The previous
// version was a grid of generic "preview" zone cards with no telemetry. The
// shell now opens with a dense operator briefing:
//   1. Mission posture telemetry tiles backed by the live issue read API.
//   2. Approval/risk and agent roster strips with truthful chips.
//   3. A short recent-activity rail derived from live issues.
//   4. A compact zone rail so navigation stays inside the landing — but the
//      visual tone matches a command center, not a marketing landing page.
//
// Cards backed by real reads carry `Data · BACKEND-BACKED`. Anything that is
// still derived/not-wired (e.g. final-delivery preview, risk-policy posture)
// keeps `Data · PREVIEW · Not connected` per LET-187 semantic-trust rules so
// QA/visibility audit sees no stealth-real claims.

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
      className="flex flex-col gap-6"
      data-testid="eaos-command-center-landing"
      data-eaos-data-connected={telemetry.companyScoped ? "true" : "false"}
    >
      <CommandCenterHeader telemetry={telemetry} />

      <CommandCenterTelemetry telemetry={telemetry} />

      <CommandCenterRiskAndRoster telemetry={telemetry} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <RecentActivity telemetry={telemetry} />
        <ZoneRail />
      </div>
    </section>
  );
}

function CommandCenterHeader({ telemetry }: { telemetry: MissionTelemetry }) {
  return (
    <header className="flex flex-col gap-3" data-testid="eaos-command-center-header">
      <div className="flex flex-wrap items-center gap-2" data-testid="eaos-command-center-posture">
        <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
        {telemetry.companyScoped ? (
          <EaosStateChip
            label="BACKEND-BACKED"
            prefix="Data"
            title="Mission and agent counts are read from the live company-scoped APIs."
          />
        ) : (
          <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
        )}
        <EaosStateChip
          label="PREVIEW"
          prefix="Tiles"
          title="Some tiles (final delivery, audit trail, evidence) are derived or not yet wired."
        />
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {telemetry.companyScoped ? "Live read · company scope" : NOT_CONNECTED_DATA_NOTE}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <div className="flex flex-col gap-1">
          <h1 id="eaos-command-center-title" className="text-2xl font-semibold tracking-tight text-foreground">
            Command Center
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Operator briefing for the current company scope. Mission posture, attention queue, agent
            roster, and recent activity read from the live issue and agent feeds. Risk gates and live
            controls stay inside Approvals / Risk and the Kernel escape hatch.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/eaos/missions"
            data-testid="eaos-command-center-open-missions"
            className="inline-flex items-center gap-1 rounded-md border border-foreground bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span>Open Missions</span>
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
          <Link
            to="/eaos/approvals"
            data-testid="eaos-command-center-open-approvals"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span>Review Approvals / Risk</span>
            <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

interface TelemetryTile {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly hint: string;
  readonly chip: EaosStateLabel;
  readonly tone:
    | "neutral"
    | "active"
    | "warning"
    | "review"
    | "success";
  readonly target: string;
}

function CommandCenterTelemetry({ telemetry }: { telemetry: MissionTelemetry }) {
  const tiles: TelemetryTile[] = [
    {
      id: "active",
      label: "Active missions",
      value: telemetry.counts.active,
      hint: "Issues in_progress for the current company scope.",
      chip: "BACKEND-BACKED",
      tone: "active",
      target: "/eaos/missions",
    },
    {
      id: "attention",
      label: "Needs attention",
      value: telemetry.criticalAttention,
      hint: "Blocked or in-review work owing a decision.",
      chip: "APPROVAL REQUIRED",
      tone: "warning",
      target: "/eaos/missions",
    },
    {
      id: "in-review",
      label: "In review",
      value: telemetry.counts.inReview,
      hint: "Awaiting reviewer / QA decision.",
      chip: "APPROVAL REQUIRED",
      tone: "review",
      target: "/eaos/approvals",
    },
    {
      id: "high-priority",
      label: "High / critical",
      value: telemetry.highPriority,
      hint: "Open work flagged high or critical priority.",
      chip: "BACKEND-BACKED",
      tone: "neutral",
      target: "/eaos/missions",
    },
    {
      id: "done",
      label: "Recently done",
      value: telemetry.counts.done,
      hint: "Missions closed in the current scope.",
      chip: "APPLIED",
      tone: "success",
      target: "/eaos/missions",
    },
  ];

  const placeholder = telemetry.isLoading
    ? "—"
    : !telemetry.companyScoped
      ? "·"
      : null;

  return (
    <ul
      role="list"
      aria-label="Mission posture telemetry"
      data-testid="eaos-command-center-telemetry"
      data-eaos-data-connected={telemetry.companyScoped ? "true" : "false"}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5"
    >
      {tiles.map((tile) => {
        // LET-187 semantic-trust: each tile claims a posture chip so an
        // operator can see at a glance whether the value is backed by a live
        // read (`BACKEND-BACKED`), gated on a decision (`APPROVAL REQUIRED`),
        // or only a preview (`PREVIEW`). When no company scope is selected we
        // collapse the chip to `Data · PREVIEW · Not connected` so we never
        // claim "backend-backed" against a missing read.
        const tileChip: { label: EaosStateLabel; prefix: string; title: string } = telemetry.companyScoped
          ? {
              label: tile.chip,
              prefix: tile.chip === "BACKEND-BACKED" ? "Data" : tile.chip === "APPROVAL REQUIRED" ? "Queue" : "Mission",
              title: `${tile.label}: ${tile.hint}`,
            }
          : {
              label: NOT_CONNECTED_DATA_LABEL,
              prefix: NOT_CONNECTED_DATA_PREFIX,
              title: NOT_CONNECTED_DATA_NOTE,
            };
        return (
          <li
            key={tile.id}
            data-testid={`eaos-command-center-telemetry-${tile.id}`}
            data-eaos-telemetry-tone={tile.tone}
            className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
              aria-label={`${tile.label}: ${placeholder ?? tile.value}`}
              data-testid={`eaos-command-center-telemetry-${tile.id}-value`}
              className="text-2xl font-semibold tracking-tight text-foreground tabular-nums"
            >
              {placeholder ?? tile.value}
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">{tile.hint}</p>
            <div className="flex items-center justify-between gap-2">
              <EaosStateChip label={tileChip.label} prefix={tileChip.prefix} title={tileChip.title} />
              <Link
                to={tile.target}
                aria-label={`${tile.label} — open ${tile.target}`}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span>Open</span>
                <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CommandCenterRiskAndRoster({ telemetry }: { telemetry: MissionTelemetry }) {
  return (
    <div
      className="grid grid-cols-1 gap-3 lg:grid-cols-3"
      data-testid="eaos-command-center-strip"
    >
      <StripCard
        testId="eaos-command-center-strip-risk"
        title="Risk posture"
        icon={<AlertOctagon aria-hidden="true" className="h-4 w-4 text-amber-600" />}
        chip={
          telemetry.companyScoped ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Data"
              title="Risk count derived from live blocked + in_review issue states."
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )
        }
        primary={`${telemetry.criticalAttention} item${telemetry.criticalAttention === 1 ? "" : "s"} awaiting decision`}
        secondary={
          telemetry.companyScoped
            ? `${telemetry.counts.blocked} blocked · ${telemetry.counts.inReview} in review`
            : "Select a company scope to load risk posture."
        }
        action={{ to: "/eaos/approvals", label: "Review queue" }}
      />
      <StripCard
        testId="eaos-command-center-strip-roster"
        title="Agent roster"
        icon={<Cpu aria-hidden="true" className="h-4 w-4 text-blue-600" />}
        chip={
          telemetry.companyScoped ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Data"
              title="Agent counts derived from the live agent roster API."
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )
        }
        primary={`${telemetry.agents.active} active · ${telemetry.agents.total} total`}
        secondary={
          telemetry.companyScoped
            ? `${telemetry.agents.executing} reporting executing · roster preview`
            : "Select a company scope to load agent roster."
        }
        action={{ to: "/eaos/agents", label: "Open roster" }}
      />
      <StripCard
        testId="eaos-command-center-strip-loop"
        title="Autonomous loop"
        icon={<Workflow aria-hidden="true" className="h-4 w-4 text-violet-600" />}
        chip={<EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />}
        primary="Loop state preview"
        secondary="Loop telemetry and operator wake controls are not wired in this slice; Kernel/Admin remains source of truth."
        action={{ to: "/eaos/runs", label: "Runs & loops" }}
      />
    </div>
  );
}

function StripCard({
  testId,
  title,
  icon,
  chip,
  primary,
  secondary,
  action,
}: {
  testId: string;
  title: string;
  icon: React.ReactNode;
  chip: React.ReactNode;
  primary: string;
  secondary: string;
  action: { to: string; label: string };
}) {
  return (
    <article
      data-testid={testId}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </h2>
        </div>
        {chip}
      </div>
      <p className="text-sm font-medium text-foreground">{primary}</p>
      <p className="text-xs text-muted-foreground">{secondary}</p>
      <div className="mt-auto pt-1.5">
        <Link
          to={action.to}
          className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span>{action.label}</span>
          <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
        </Link>
      </div>
    </article>
  );
}

function RecentActivity({ telemetry }: { telemetry: MissionTelemetry }) {
  return (
    <section
      aria-labelledby="eaos-command-center-activity-title"
      data-testid="eaos-command-center-activity"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CircleDot aria-hidden="true" className="h-4 w-4 text-foreground" />
          <h2
            id="eaos-command-center-activity-title"
            className="text-sm font-semibold tracking-tight text-foreground"
          >
            Recent mission activity
          </h2>
        </div>
        {telemetry.companyScoped ? (
          <EaosStateChip
            label="BACKEND-BACKED"
            prefix="Data"
            title="Rows derived from the live issue read API for the current company scope."
          />
        ) : (
          <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
        )}
      </div>

      {telemetry.isError ? (
        <div
          role="alert"
          data-testid="eaos-command-center-activity-error"
          className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground"
        >
          Activity feed is temporarily unavailable. Agents continue from their own context.
        </div>
      ) : !telemetry.companyScoped ? (
        <ActivityEmpty
          testId="eaos-command-center-activity-no-company"
          title="No company scope selected"
          body="Pick a company in the workspace switcher to see live mission activity here."
        />
      ) : telemetry.isLoading ? (
        <ActivityEmpty
          testId="eaos-command-center-activity-loading"
          title="Loading recent activity"
          body="Reading live missions for this company scope."
        />
      ) : telemetry.recent.length === 0 ? (
        <ActivityEmpty
          testId="eaos-command-center-activity-empty"
          title="No active missions yet"
          body="When new work is created or picked up it will appear here."
        />
      ) : (
        <ul aria-label="Active missions" className="flex flex-col gap-1.5">
          {telemetry.recent.map((issue) => (
            <ActivityRow key={issue.id} issue={issue} />
          ))}
        </ul>
      )}

      {telemetry.recentlyCompleted.length > 0 ? (
        <div
          data-testid="eaos-command-center-activity-completed"
          className="border-t border-dashed border-border pt-2"
        >
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Recently completed
          </p>
          <ul aria-label="Recently completed missions" className="flex flex-col gap-1">
            {telemetry.recentlyCompleted.map((issue) => (
              <ActivityRow key={issue.id} issue={issue} compact />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ActivityEmpty({ testId, title, body }: { testId: string; title: string; body: string }) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-dashed border-border bg-background p-3"
    >
      <p className="text-xs font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{body}</p>
    </div>
  );
}

function statusChip(status: Issue["status"]): { label: EaosStateLabel; prefix: string } {
  switch (status) {
    case "in_review":
      return { label: "APPROVAL REQUIRED", prefix: "Mission" };
    case "blocked":
      return { label: "FAILED", prefix: "Mission" };
    case "done":
      return { label: "APPLIED", prefix: "Mission" };
    case "cancelled":
      return { label: "PREVIEW", prefix: "Mission" };
    case "in_progress":
    case "todo":
      return { label: "BACKEND-BACKED", prefix: "Mission" };
    case "backlog":
    default:
      return { label: "PREVIEW", prefix: "Mission" };
  }
}

function ActivityRow({ issue, compact = false }: { issue: Issue; compact?: boolean }) {
  const chip = statusChip(issue.status);
  const missionRef = issue.identifier ?? issue.id;
  const safeTitle = redactSecretLikeText(issue.title);
  return (
    <li
      data-testid={`eaos-command-center-activity-row-${issue.id}`}
      data-eaos-activity-status={issue.status}
      className={
        "flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs " +
        (compact ? "opacity-90" : "")
      }
    >
      {issue.identifier ? (
        <span
          aria-label={`Mission identifier ${issue.identifier}`}
          className="shrink-0 rounded-md border border-dashed border-border bg-card px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {issue.identifier}
        </span>
      ) : null}
      <Link
        to={`/eaos/missions/${missionRef}`}
        className="min-w-0 flex-1 truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        title={safeTitle}
      >
        {safeTitle}
      </Link>
      <EaosStateChip
        label={chip.label}
        prefix={chip.prefix}
        title={`Status derived from issue.status=${issue.status}`}
      />
    </li>
  );
}

function ZoneRail() {
  return (
    <nav
      aria-label="Quick zone jump"
      data-testid="eaos-command-center-zones"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Compass aria-hidden="true" className="h-4 w-4 text-foreground" />
          <h2 className="text-sm font-semibold tracking-tight text-foreground">Jump to zone</h2>
        </div>
        <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Operator
        </p>
        {EAOS_PRIMARY_NAV_ZONES.filter((zone) => zone.path !== "/eaos").map((zone) => (
          <ZoneRailCard key={zone.id} zone={zone} tone="primary" />
        ))}
        <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Build / admin
        </p>
        {EAOS_SECONDARY_NAV_ZONES.map((zone) => (
          <ZoneRailCard key={zone.id} zone={zone} tone="secondary" />
        ))}
      </div>
    </nav>
  );
}

function ZoneRailCard({
  zone,
  tone,
}: {
  zone: { id: string; label: string; description: string; path: string };
  tone: "primary" | "secondary";
}) {
  return (
    <article
      data-testid={`eaos-landing-card-${zone.id}`}
      data-eaos-data-connected="false"
      className={
        "flex items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs " +
        (tone === "primary" ? "border-border" : "border-dashed border-border")
      }
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          to={zone.path}
          aria-label={`Open ${zone.label}`}
          className="truncate text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {zone.label}
        </Link>
        <span className="truncate text-[11px] text-muted-foreground">{zone.description}</span>
      </div>
      <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
    </article>
  );
}
