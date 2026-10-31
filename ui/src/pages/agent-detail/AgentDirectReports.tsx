import { useLayoutEffect, useRef, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Link } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { agentDetailHref } from "../agent-detail-navigation";

const MAX_LINES = 2;
const itemClass = "inline-flex min-w-0 max-w-full items-center gap-1.5";
const toggleClass = "text-muted-foreground transition-colors hover:text-foreground";

function lineCount(widths: number[], available: number, gap: number) {
  let lines = 0;
  let used = 0;
  for (const width of widths) {
    if (lines > 0 && used + gap + width <= available) {
      used += gap + width;
    } else {
      lines += 1;
      used = width;
    }
  }
  return lines;
}

export function fitReports(widths: number[], available: number, gap: number, moreWidth: number, maxLines = MAX_LINES) {
  if (available <= 0 || lineCount(widths, available, gap) <= maxLines) return widths.length;
  for (let shown = widths.length - 1; shown > 0; shown -= 1) {
    if (lineCount([...widths.slice(0, shown), moreWidth], available, gap) <= maxLines) return shown;
  }
  return 0;
}

export function AgentDirectReports({ reports }: { reports: Agent[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(reports.length);
  const [expanded, setExpanded] = useState(false);
  const reportsKey = reports.map((report) => `${report.id}:${report.name}`).join("|");

  useLayoutEffect(() => {
    const list = listRef.current;
    const measure = measureRef.current;
    if (!list || !measure) return;
    const fit = () => {
      const widths = Array.from(measure.children, (child) => Math.ceil(child.getBoundingClientRect().width));
      const moreWidth = widths.pop() ?? 0;
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      setShown(fitReports(widths, Math.floor(list.clientWidth), gap, moreWidth));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(list);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [reportsKey]);

  const hidden = expanded ? 0 : Math.max(0, reports.length - shown);
  const visible = hidden > 0 ? reports.slice(0, shown) : reports;

  return (
    <div className="relative">
      <div ref={listRef} className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {visible.map((report) => (
          <Link
            key={report.id}
            to={agentDetailHref(agentRouteRef(report))}
            className={`${itemClass} text-foreground no-underline hover:underline`}
          >
            <AgentAvatar agent={report} size={20} />
            <span className="truncate">{report.name}</span>
          </Link>
        ))}
        {hidden > 0 ? (
          <button type="button" className={toggleClass} onClick={() => setExpanded(true)}>
            +{hidden} more
          </button>
        ) : null}
        {expanded && shown < reports.length ? (
          <button type="button" className={toggleClass} onClick={() => setExpanded(false)}>
            Show less
          </button>
        ) : null}
      </div>
      <div aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={measureRef} className="flex w-max">
          {reports.map((report) => (
            <span key={report.id} className="inline-flex items-center gap-1.5">
              <AgentAvatar agent={report} size={20} />
              <span>{report.name}</span>
            </span>
          ))}
          <span>+{reports.length} more</span>
        </div>
      </div>
    </div>
  );
}
