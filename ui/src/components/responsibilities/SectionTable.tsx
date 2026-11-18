import { createContext, useContext, type ReactNode } from "react";
import type { Agent } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Card } from "@/components/ui/card";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * One section of the "One screen v2" responsibility page as a table: a
 * bordered card whose header bar carries the section's name at the left and
 * its "+" at the right, with the rows beneath it separated by hairlines.
 *
 * Each row is what identifies it at the left, then one stat, then who has it
 * (when the table has that column), in columns that line up down the table:
 * the rows share the list's grid, so the stat and avatar columns are as wide
 * as their widest cell. On narrow screens the stat drops under the title.
 * An empty table is its header bar and one muted row of a few words.
 */

/** Whether the table's rows have a "who" column after the stat. */
const WithWho = createContext(true);

export function SectionTable({
  section,
  title,
  add,
  empty,
  withWho = true,
  children,
  footer,
}: {
  /** The section's key, on `data-section`. */
  section: string;
  title: string;
  /** The "+" at the header bar's right. */
  add?: ReactNode;
  /** When set, the table has no rows and shows these words in one muted row instead. */
  empty?: ReactNode;
  /** False when no row has someone to show: the stat is then the last column. */
  withWho?: boolean;
  /** `SectionTableRow`s. */
  children?: ReactNode;
  /** Quiet rows below the list: `SectionTableFooterButton` or `SectionTableNote`. */
  footer?: ReactNode;
}) {
  const headingId = `one-screen-v2-${section}-heading`;
  return (
    <section aria-labelledby={headingId} data-section={section}>
      <Card elevation="low" className="gap-0 overflow-hidden py-0" data-section-table="">
        <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-4 py-2" data-section-header="">
          <h2 id={headingId} className="text-sm font-semibold text-foreground">{title}</h2>
          {add}
        </div>
        {empty != null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground" data-section-empty="">{empty}</p>
        ) : (
          <WithWho.Provider value={withWho}>
            <ul
              className={cn(
                "flex flex-col divide-y divide-border sm:grid sm:gap-x-6",
                withWho ? "sm:grid-cols-(--gtc-27)" : "sm:grid-cols-(--gtc-13)",
              )}
              data-section-rows=""
            >
              {children}
            </ul>
          </WithWho.Provider>
        )}
        {footer}
      </Card>
    </section>
  );
}

export function SectionTableRow({
  to,
  label,
  leading,
  title,
  aside,
  stat,
  who,
  rowData,
}: {
  to: string;
  /** The link's accessible name, when the row's own text does not say it all. */
  label?: string;
  /** A small mark before the title: a task's status glyph, an artifact's kind. */
  leading?: ReactNode;
  /** Truncates on one line; the full text is on hover and in the link's name. */
  title: string;
  /** Something quiet at the title column's right edge (a project's progress). */
  aside?: ReactNode;
  /** The row's one fact, in the muted style. */
  stat?: ReactNode;
  /** Who has it: an avatar, or the avatars of those who hold it. */
  who?: ReactNode;
  /** `data-*` attributes for the row's list item. */
  rowData?: Record<`data-${string}`, string>;
}) {
  const withWho = useContext(WithWho);
  return (
    <li className="min-w-0 sm:col-span-full sm:grid sm:grid-cols-subgrid" {...rowData}>
      <Link
        to={to}
        aria-label={label}
        className="flex min-h-11 min-w-0 items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:col-span-full sm:grid sm:grid-cols-subgrid"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:contents">
          <span className="flex min-w-0 items-center gap-2" data-row-title="">
            {leading}
            <span className="min-w-0 truncate text-foreground" title={title}>{title}</span>
            {aside ? <span className="ml-auto flex shrink-0 items-center pl-2">{aside}</span> : null}
          </span>
          {stat != null && stat !== "" ? (
            <span className="min-w-0 truncate text-muted-foreground tabular-nums sm:whitespace-nowrap sm:text-right" data-row-stat="">{stat}</span>
          ) : (
            <span aria-hidden="true" className="hidden sm:block" />
          )}
        </span>
        {withWho ? (
          who ? <span className="flex shrink-0 items-center justify-end gap-1" data-row-who="">{who}</span> : <span aria-hidden="true" className="hidden sm:block" />
        ) : null}
      </Link>
    </li>
  );
}

/** A quiet row under the list that changes what it shows ("Show 2 done"). */
export function SectionTableFooterButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center border-t border-border px-4 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-section-footer=""
    >
      {children}
    </button>
  );
}

/** A line under the list: something that went wrong, or that it is still loading. */
export function SectionTableNote({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? "alert" : undefined}
      className={cn("border-t border-border px-4 py-3 text-sm", alert ? "text-destructive" : "text-muted-foreground")}
    >
      {children}
    </p>
  );
}

/** An agent's avatar for the "who" column, named on hover and for screen readers. */
export function WhoAvatar({ agentId, agentsById }: { agentId: string | null; agentsById: ReadonlyMap<string, Agent> }) {
  if (!agentId) return null;
  const agent = agentsById.get(agentId);
  const name = agent?.name ?? "An agent";
  return (
    <span title={name} className="flex shrink-0">
      <AgentAvatar agent={agent ?? { id: agentId }} name={agent?.name} size={20} label={name} />
    </span>
  );
}

/** A task's identifier and a time, as one stat: "PAP-42  1d ago". */
export function TaskRefStat({ identifier, when }: { identifier: string | null; when: string }) {
  return (
    <span className="inline-flex items-center gap-3">
      {identifier ? <span className="font-mono">{identifier}</span> : null}
      <span className="sm:inline-block sm:min-w-16 sm:text-right">{when}</span>
    </span>
  );
}
