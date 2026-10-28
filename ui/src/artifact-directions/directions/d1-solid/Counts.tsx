import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { MetaDot } from "./MetaLine";
import { StateDot } from "./StateMarker";

/**
 * The mono count label, one grammar on every surface: a total in foreground,
 * then any breakdown, then what is waiting — each waiting count behind its
 * state dot, which is its separator. The caller sets the mono recipe
 * (META_TEXT) and the muted colour for the fill it sits on.
 *
 *   thread    5 attachments · 1 image · 4 files  ● 5 to review
 *   panel     21 artifacts  ● 9 to review
 *   gallery   6 stacks · 43 artifacts  ● 12 to review  ● 1 change requested
 *
 * Every item is unbreakable and the label wraps between items, so in a narrow
 * tile or pane it takes a second line instead of running out of its slab.
 */

const reviewCount = (items: LabArtifact[]) => items.filter((a) => a.review === "needs_review").length;
const changesCount = (items: LabArtifact[]) => items.filter((a) => a.review === "changes_requested").length;

export function Counts({
  lead,
  parts = [],
  of,
  leadClassName = "text-foreground",
}: {
  /** "21 artifacts" */
  lead: string;
  /** Plain breakdown after the lead: "1 image", "4 files". */
  parts?: string[];
  /** The artifacts counted: what waits among them is appended behind its state dot. */
  of?: LabArtifact[];
  leadClassName?: string;
}) {
  const review = of ? reviewCount(of) : 0;
  const changes = of ? changesCount(of) : 0;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2.5">
      <span className="whitespace-nowrap">
        <span className={leadClassName}>{lead}</span>
        {parts.map((part) => (
          <Fragment key={part}>
            <MetaDot />
            {part}
          </Fragment>
        ))}
      </span>
      {review > 0 ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <StateDot state="needs_review" />
          {review} to review
        </span>
      ) : null}
      {changes > 0 ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <StateDot state="changes_requested" />
          {changes} {changes === 1 ? "change" : "changes"} requested
        </span>
      ) : null}
    </span>
  );
}
