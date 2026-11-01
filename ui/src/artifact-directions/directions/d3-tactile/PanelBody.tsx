import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { REVIEW_VAR } from "./kind";
import { ArtifactObject } from "./objects/ArtifactObject";
import { onlyToReview, sectionsOf } from "./panel-order";
import { PanelDivider } from "./PanelDivider";
import { BUTTON_RING } from "./PanelActions";
import { PanelItem } from "./PanelItem";

/**
 * PANEL — the task's shelf: everything the task has produced, laid out on
 * the desk.
 *
 * One column of objects with captions (`PanelItem`), sectioned by the run
 * that produced them behind a tabbed divider (`PanelDivider`); what has no
 * run — task documents, links — is one more section. Newest first, as in the
 * product. A two-way switch at the top narrows the desk to what is flagged
 * for review. Each section is the `desk` container its rows measure
 * themselves against.
 */

type Filter = "all" | "review";

const FLAG = { "--tac-flag": REVIEW_VAR.needs_review, clipPath: "var(--tac-clip-flag)" } as CSSProperties;

function FilterButton({ pressed, onPress, count, children }: { pressed: boolean; onPress: () => void; count: number; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-pressed={pressed}
      onClick={onPress}
      className={cn("h-7 gap-1.5 px-2 text-(--tac-meta) aria-pressed:bg-(--tac-key) aria-pressed:text-foreground aria-pressed:shadow-(--tac-key-edge)", BUTTON_RING)}
    >
      {children}
      <span className="font-mono text-(length:--text-micro)">{count}</span>
    </Button>
  );
}

const BLANK: LabArtifact = { id: "empty", kind: "file", title: "", author: "", updatedAt: "", updatedLabel: "", dayLabel: "", taskIdentifier: "", taskTitle: "" };

function Empty() {
  return (
    <div className="flex items-center gap-4 px-1 py-6">
      <ArtifactObject artifact={BLANK} size="sm" flag="none" repose={2} />
      <p className="text-sm text-(--tac-meta)">No artifacts yet. Work products, documents, and agent-produced files will appear here.</p>
    </div>
  );
}

export function PanelBody({ artifacts }: { artifacts: LabArtifact[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const sections = useMemo(() => sectionsOf(artifacts), [artifacts]);
  const toReview = sections.reduce((sum, section) => sum + section.reviewCount, 0);
  const shown = filter === "review" && toReview > 0 ? onlyToReview(sections) : sections;

  if (artifacts.length === 0) return <Empty />;
  return (
    <div data-tac-desk className="-m-4 flex flex-col gap-7 bg-(--tac-desk) bg-(image:--tac-ground-grain) p-4 pb-6 shadow-(--tac-desk-rim)">
      {toReview > 0 ? (
        <div role="group" aria-label="Show" className="-mb-2 flex items-center gap-1">
          <FilterButton pressed={filter === "all"} onPress={() => setFilter("all")} count={artifacts.length}>
            All
          </FilterButton>
          <FilterButton pressed={filter === "review"} onPress={() => setFilter("review")} count={toReview}>
            <span aria-hidden className="block h-2.5 w-3.5 bg-(--tac-flag)" style={FLAG} />
            To review
          </FilterButton>
        </div>
      ) : null}
      {shown.map((section) => (
        <section key={section.id} aria-label={section.run ? `${section.label}, run started ${section.run.startedLabel}` : section.label} className="@container/desk flex flex-col">
          <PanelDivider section={section} />
          <ul className="flex flex-col">
            {section.items.map((artifact) => (
              <PanelItem key={artifact.id} artifact={artifact} showAuthor={!section.run} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
