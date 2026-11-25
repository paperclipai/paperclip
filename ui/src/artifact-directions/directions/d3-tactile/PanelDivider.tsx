import { countLabel } from "./gallery-model";
import type { PanelSection } from "./panel-order";
import { StateFlag } from "./StateFlag";

/**
 * PANEL — the divider that introduces a run: folder board with a tab, as in
 * a file drawer. The tab names the agent and counts what the run left. If
 * anything under it waits for review, a flag with the number stands on the
 * far end of the board's edge — clear of the tab's label and of the flag on
 * the first object below. The run's start time is written under the board,
 * at every pane width.
 */

const SHADOW = { filter: "var(--tac-divider-shadow)" } as const;

export function PanelDivider({ section }: { section: PanelSection }) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="relative flex items-end justify-between gap-3 pb-(--tac-divider-bar)">
        <span className="relative flex min-w-0 max-w-(--tac-divider-max)" style={SHADOW}>
          <h3
            className="flex h-(--tac-divider-h) min-w-0 items-center gap-2 rounded-tl-md bg-(--tac-folder) bg-(image:--tac-board-grain) pl-2.5 pr-0.5 text-xs font-medium text-(--tac-folder-ink)"
            title={section.run ? `${section.label} · run started ${section.run.startedLabel}` : section.label}
          >
            <span className="truncate">{section.label}</span>
            <span className="font-mono text-(length:--text-micro) font-normal text-(--tac-folder-meta)">
              {section.items.length}
              <span className="sr-only"> {countLabel(section.items.length)}</span>
            </span>
          </h3>
          {/* The tab's shoulder. */}
          <svg aria-hidden viewBox="0 0 16 26" preserveAspectRatio="none" fill="currentColor" className="h-(--tac-divider-h) w-4 shrink-0 text-(--tac-folder)">
            <path d="M0 0C8 0 8 26 16 26H0z" />
          </svg>
        </span>
        {/* Stuck to the board's edge by its foot, the rest standing proud. */}
        {section.reviewCount > 0 ? <StateFlag review="needs_review" count={section.reviewCount} className="relative z-10 -mb-(--tac-divider-bar) mr-2 shrink-0" /> : null}
        {/* The board's top edge, running the width of the pane. */}
        <span aria-hidden className="absolute inset-x-0 bottom-0 block h-(--tac-divider-bar) rounded-r-full bg-(--tac-folder)" />
      </div>
      {section.run ? (
        <p className="pl-0.5 text-(length:--text-micro) leading-4 text-(--tac-meta)">
          Run started{" "}
          <time dateTime={section.run.startedAt} className="font-mono">
            {section.run.startedLabel}
          </time>
        </p>
      ) : null}
    </header>
  );
}
