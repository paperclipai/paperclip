import type { ReactNode } from "react";
import type {
  Agent,
  CompanyArtifact,
  ResponsibilityDetail,
  ResponsibilityHealth,
  ResponsibilitySkillSummary,
} from "@paperclipai/shared";
import { RESPONSIBILITY_ARTIFACT_COUNT_LIMIT } from "@paperclipai/shared";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FileText,
  FolderOpen,
  Inbox,
  MoreHorizontal,
  Repeat,
  SquarePen,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { SkillCardIcon } from "@/components/SkillCardIcon";
import { StatusIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { skillRoute } from "@/lib/company-skill-routes";
import { RESPONSIBILITY_HEALTH_LABEL } from "@/lib/responsibilities";
import { WORK_ITEM_KIND_LABEL, type WorkItem } from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { cn } from "@/lib/utils";
import { healthStatusStyle } from "./ResponsibilityHealthBadge";
import type { ResponsibilityPageActions } from "./ResponsibilityPageLayout";

/** One glyph per status, so status never rests on colour alone. */
export const HEALTH_ICON: Record<ResponsibilityHealth, LucideIcon> = {
  behind: CircleAlert,
  at_risk: TriangleAlert,
  on_track: CircleCheck,
  not_measured: CircleDashed,
};

/** A status dot in the status hue. Pair it with a visible label, or pass `label` for screen readers. */
export function HealthDot({ health, label, className }: { health: ResponsibilityHealth; label?: string; className?: string }) {
  return (
    <>
      <span
        className={cn("status-fill inline-block size-2.5 shrink-0 rounded-full", className)}
        style={healthStatusStyle(health)}
        aria-hidden="true"
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  );
}

/** A status as a dot and its word: "● At risk". */
export function HealthMark({ health, className }: { health: ResponsibilityHealth; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <HealthDot health={health} className="size-2" />
      {RESPONSIBILITY_HEALTH_LABEL[health]}
    </span>
  );
}

/**
 * Proposals waiting for review, as one compact line: how many, and a way to
 * review them (the full layout holds the review).
 */
export function ProposalsNotice({
  count,
  onReview,
  subject = "list",
  className,
}: {
  count: number;
  onReview: () => void;
  /** "list": proposals on the Dashboard; "this": the responsibility on this page is one. */
  subject?: "list" | "this";
  className?: string;
}) {
  if (count <= 0) return null;
  const message =
    subject === "this"
      ? "This responsibility was proposed for you and is waiting for your review."
      : count === 1
        ? "1 proposed responsibility is waiting for your review."
        : `${count} proposed responsibilities are waiting for your review.`;
  return (
    <div
      role="status"
      data-proposals-notice=""
      className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-4 py-2", className)}
    >
      <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <Inbox aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {message}
      </p>
      <Button size="xs" variant="outline" onClick={onReview}>
        {subject === "this" || count === 1 ? "Review it" : "Review them"}
      </Button>
    </div>
  );
}

/** The top of a responsibility in a simpler view: its area and its name, read-only. */
export function ResponsibilityViewHeader({
  responsibility,
  actions,
  children,
}: {
  responsibility: Pick<ResponsibilityDetail, "title" | "area" | "status">;
  /** Buttons at the right of the name. */
  actions?: ReactNode;
  /** Notices from the page, below the name. */
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1">
      {responsibility.area ? (
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{responsibility.area.title}</p>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 flex-1 text-2xl font-semibold text-foreground">{responsibility.title}</h1>
        {actions}
      </div>
      {responsibility.status === "let_go" ? (
        <p className="text-sm text-muted-foreground">You let go of this.</p>
      ) : responsibility.status === "dismissed" ? (
        <p className="text-sm text-muted-foreground">You dismissed this when it was proposed.</p>
      ) : null}
      {children}
    </header>
  );
}

/**
 * The responsibility page's header actions, as the full layout has them:
 * "New task for an agent" while it is active, and the menu with Let go (or
 * Take it back on) and Delete. Uses the page's own actions.
 */
export function ResponsibilityHeaderActions({
  status,
  actions,
}: {
  status: ResponsibilityDetail["status"];
  actions: Pick<ResponsibilityPageActions, "newTask" | "setStatus" | "requestDelete">;
}) {
  const isActive = status === "active";
  return (
    <div className="flex shrink-0 items-center gap-2" data-responsibility-header-actions="">
      {isActive ? (
        <Button variant="outline" onClick={() => actions.newTask({ defaultTitle: "" })}>
          <SquarePen aria-hidden="true" />
          New task for an agent
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="More actions for this responsibility">
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isActive ? (
            <DropdownMenuItem onSelect={() => actions.setStatus("let_go")}>Let go</DropdownMenuItem>
          ) : status === "let_go" || status === "dismissed" ? (
            <DropdownMenuItem onSelect={() => actions.setStatus("active")}>Take it back on</DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={actions.requestDelete}>
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const KIND_ICON = { project: FolderOpen, routine: Repeat } as const;

/** What kind of thing a row is: its icon and its word. Tasks show their status glyph. */
export function WorkKind({ item, showLabel }: { item: WorkItem; showLabel: boolean }) {
  const Icon = item.kind === "task" ? null : KIND_ICON[item.kind];
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground", showLabel && "w-20")}>
      {item.kind === "task" ? (
        <StatusIcon {...taskStatusIconProps(item.task)} size="sm" />
      ) : Icon ? (
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : null}
      {showLabel ? WORK_ITEM_KIND_LABEL[item.kind] : null}
    </span>
  );
}

/**
 * One project, task or routine: what kind it is, its name, and what is wrong
 * (or a quiet note). Opens its page. `showKind={false}` drops the kind's word
 * where a heading already says it.
 */
export function WorkItemRow({ item, dense = false, showKind = true }: { item: WorkItem; dense?: boolean; showKind?: boolean }) {
  return (
    <li data-work-kind={item.kind} data-work-id={item.id} data-attention={item.attention ? "true" : undefined}>
      <Link
        to={item.href}
        className={cn(
          "flex min-w-0 items-center gap-3 px-4 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          dense ? "py-1.5" : "py-2",
        )}
      >
        <WorkKind item={item} showLabel={showKind} />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {item.kind === "task" && item.task.identifier ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.task.identifier}</span>
          ) : null}
          <span className="truncate text-foreground">{item.title}</span>
        </span>
        {item.attention ? (
          <span className="shrink-0 text-xs text-(--status-task-icon-blocked)">{item.attention}</span>
        ) : item.note ? (
          <span className="shrink-0 text-xs text-muted-foreground">{item.note}</span>
        ) : null}
      </Link>
    </li>
  );
}

/** How many of each to show in a strip of `slots` cards: skills get at least half when they have them. */
export function stripSlots(skills: number, artifacts: number, slots = 4): { skills: number; artifacts: number } {
  const shownSkills = Math.min(skills, Math.max(Math.ceil(slots / 2), slots - artifacts));
  return { skills: shownSkills, artifacts: Math.min(artifacts, slots - shownSkills) };
}

function moreLine(moreSkills: number, moreArtifacts: number, artifactsCapped: boolean): string | null {
  const parts: string[] = [];
  if (moreSkills > 0) parts.push(`${moreSkills} more ${moreSkills === 1 ? "skill" : "skills"}`);
  if (moreArtifacts > 0) {
    parts.push(artifactsCapped ? "many more artifacts" : `${moreArtifacts.toLocaleString("en-US")} more ${moreArtifacts === 1 ? "artifact" : "artifacts"}`);
  }
  if (parts.length === 0) return null;
  return `And ${parts.join(" and ")}.`;
}

function StripCard({ to, icon, title, kind }: { to: string; icon: ReactNode; title: string; kind: string }) {
  return (
    <li className="min-w-0">
      <Card elevation="low" className="h-full gap-0 py-0">
        <Link
          to={to}
          className="flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {icon}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
            <span className="truncate text-xs text-muted-foreground">{kind}</span>
          </span>
        </Link>
      </Card>
    </li>
  );
}

/** "1 more skill", "61 more artifacts", "many more artifacts". */
function moreOf(count: number, one: string, many: string, capped = false): string | null {
  if (count <= 0) return null;
  if (capped) return `and many more ${many}`;
  return `and ${count.toLocaleString("en-US")} more ${count === 1 ? one : many}`;
}

function CardsSection({
  kind,
  title,
  count,
  empty,
  more,
  children,
}: {
  kind: "skill" | "artifact";
  title: string;
  count: number;
  empty: string;
  more: string | null;
  children: ReactNode;
}) {
  const headingId = `one-screen-${kind}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-card-list={kind}>
      <h2 id={headingId} className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
        {title} <span className="text-xs font-normal tabular-nums text-muted-foreground">{count.toLocaleString("en-US")}</span>
      </h2>
      {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid={`responsibility-${kind}-cards`}>{children}</ul>
      )}
      {more ? <p className="text-xs text-muted-foreground">{more}</p> : null}
    </section>
  );
}

/** Skill cards: each skill's icon, name and who holds it, opening the skill. */
function skillCards(skills: readonly ResponsibilitySkillSummary[], agentsById: ReadonlyMap<string, Agent>) {
  return skills.map((skill) => {
    const holder = skill.agentIds[0] ? agentsById.get(skill.agentIds[0])?.name : undefined;
    return (
      <StripCard
        key={`skill:${skill.id}`}
        to={skillRoute(skill)}
        icon={<SkillCardIcon card={skill} size={24} />}
        title={skill.name}
        kind={holder ? `${holder}${skill.agentIds.length > 1 ? ` and ${skill.agentIds.length - 1} more` : ""}` : "Skill"}
      />
    );
  });
}

/** Artifact cards: each artifact's name and the task it came from, opening it. */
function artifactCards(artifacts: readonly CompanyArtifact[]) {
  return artifacts.map((artifact) => (
    <StripCard
      key={`artifact:${artifact.source}:${artifact.id}`}
      to={artifact.href}
      icon={<FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />}
      title={artifact.title}
      kind={artifact.issue.identifier ? `From ${artifact.issue.identifier}` : "Artifact"}
    />
  ));
}

/** The cards alone, without a heading or counts: a grid of up to `cap` (one column on narrow screens). */
export function CompactCardGrid({
  kind,
  skills = [],
  artifacts = [],
  agentsById = new Map(),
  cap = 4,
}: {
  kind: "skill" | "artifact";
  skills?: readonly ResponsibilitySkillSummary[];
  artifacts?: readonly CompanyArtifact[];
  agentsById?: ReadonlyMap<string, Agent>;
  cap?: number;
}) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid={`responsibility-${kind}-cards`}>
      {kind === "skill" ? skillCards(skills.slice(0, cap), agentsById) : artifactCards(artifacts.slice(0, cap))}
    </ul>
  );
}

/** The skills of the agents working on it, as small cards: the first `cap`, then how many more. */
export function SkillCards({
  skills,
  agentsById,
  cap = 4,
}: {
  skills: readonly ResponsibilitySkillSummary[];
  agentsById: ReadonlyMap<string, Agent>;
  cap?: number;
}) {
  const shown = skills.slice(0, cap);
  return (
    <CardsSection
      kind="skill"
      title="Skills"
      count={skills.length}
      empty="No skills yet. They come from the agents doing the work."
      more={moreOf(skills.length - shown.length, "skill", "skills")}
    >
      {skillCards(shown, agentsById)}
    </CardsSection>
  );
}

/** What its tasks produced, newest first, as small cards: the first `cap`, then how many more. */
export function ArtifactCards({
  artifacts,
  total,
  cap = 4,
}: {
  artifacts: readonly CompanyArtifact[];
  total: number;
  cap?: number;
}) {
  const shown = artifacts.slice(0, cap);
  return (
    <CardsSection
      kind="artifact"
      title="Artifacts"
      count={total}
      empty="Nothing produced yet."
      more={moreOf(Math.max(0, total - shown.length), "artifact", "artifacts", total >= RESPONSIBILITY_ARTIFACT_COUNT_LIMIT)}
    >
      {artifactCards(shown)}
    </CardsSection>
  );
}

/**
 * Skills and artifacts as one short strip of small cards (skills of the
 * agents on it, then what its tasks produced, newest first), with how many
 * more there are.
 */
export function SkillArtifactStrip({
  skills,
  artifacts,
  artifactsTotal,
  agentsById,
  slots = 4,
}: {
  skills: readonly ResponsibilitySkillSummary[];
  artifacts: readonly CompanyArtifact[];
  artifactsTotal: number;
  agentsById: ReadonlyMap<string, Agent>;
  slots?: number;
}) {
  const counts = stripSlots(skills.length, artifacts.length, slots);
  const shownSkills = skills.slice(0, counts.skills);
  const shownArtifacts = artifacts.slice(0, counts.artifacts);
  const more = moreLine(
    skills.length - shownSkills.length,
    Math.max(0, artifactsTotal - shownArtifacts.length),
    artifactsTotal >= RESPONSIBILITY_ARTIFACT_COUNT_LIMIT,
  );
  return (
    <section aria-labelledby="responsibility-strip-heading" className="flex flex-col gap-2">
      <h2 id="responsibility-strip-heading" className="text-sm font-semibold text-foreground">
        Skills and artifacts
      </h2>
      {shownSkills.length + shownArtifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills or artifacts yet.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="responsibility-strip">
          {shownSkills.map((skill) => {
            const holder = skill.agentIds[0] ? agentsById.get(skill.agentIds[0])?.name : undefined;
            return (
              <StripCard
                key={`skill:${skill.id}`}
                to={skillRoute(skill)}
                icon={<SkillCardIcon card={skill} size={24} />}
                title={skill.name}
                kind={holder ? `Skill · ${holder}${skill.agentIds.length > 1 ? ` and ${skill.agentIds.length - 1} more` : ""}` : "Skill"}
              />
            );
          })}
          {shownArtifacts.map((artifact) => (
            <StripCard
              key={`artifact:${artifact.source}:${artifact.id}`}
              to={artifact.href}
              icon={<FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />}
              title={artifact.title}
              kind={artifact.issue.identifier ? `Artifact · ${artifact.issue.identifier}` : "Artifact"}
            />
          ))}
        </ul>
      )}
      {more ? <p className="text-xs text-muted-foreground">{more}</p> : null}
    </section>
  );
}
