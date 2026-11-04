import type { CaseSummary } from "@/api/cases";
import { AgentIdentity } from "@/components/AgentIdentity";
import { EntityRow } from "@/components/EntityRow";
import { useCaseHref } from "@/lib/router";
import { CaseStatus } from "./CaseStatus";
import { DEFAULT_CASE_COLUMNS, type CaseColumn } from "@/lib/case-list-view";
import { formatDateTime, relativeTime } from "@/lib/utils";

export function CaseListRow({
  caseData,
  projectName,
  search = "",
  columns = DEFAULT_CASE_COLUMNS,
}: {
  caseData: CaseSummary;
  projectName?: string;
  search?: string;
  columns?: readonly CaseColumn[];
}) {
  const caseHref = useCaseHref();
  const task = caseData.workIssue;
  const show = new Set(columns);
  const showWork = show.has("phase") || show.has("assignee");
  const assignee = task?.assigneeAgentId
    ? { id: task.assigneeAgentId, name: task.assigneeAgentName ?? "Agent" }
    : null;
  const work = task ? <>
    {show.has("phase") && caseData.phase ? <span className="text-xs text-muted-foreground">{caseData.phase}</span> : null}
    {show.has("assignee") && (assignee ? <AgentIdentity agent={assignee} size="xs" /> : <span className="text-xs text-muted-foreground">Unassigned</span>)}
  </> : <span className="text-xs text-muted-foreground">{caseData.workIssueId ? "Task unavailable" : "No task linked"}</span>;
  const subtitle = [show.has("identifier") ? caseData.identifier : null, show.has("type") ? caseData.caseType : null,
    show.has("project") ? projectName : null].filter(Boolean);

  return (
    <EntityRow
      to={`${caseHref(caseData.identifier)}${search}`}
      title={caseData.title}
      titleTextClassName="line-clamp-2 font-medium sm:line-clamp-1"
      subtitle={subtitle.length ? subtitle.map((part, index) => <span key={index} className={part === caseData.identifier ? "font-mono" : undefined}>{index > 0 ? " · " : ""}{part}</span>) : undefined}
      className="px-3 py-3"
      trailing={showWork || show.has("status") || show.has("updated") ? <>
        {showWork && <div className="hidden w-44 flex-col gap-1 lg:flex">{work}</div>}
        {show.has("status") && <div className="flex w-24 justify-end"><CaseStatus status={caseData.status} /></div>}
        {show.has("updated") && <time dateTime={caseData.updatedAt} title={formatDateTime(caseData.updatedAt)} className="hidden font-mono text-xs text-muted-foreground sm:block">{relativeTime(caseData.updatedAt)}</time>}
      </> : undefined}
      secondaryRow={showWork ? <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{work}</div> : undefined}
      secondaryRowClassName="pl-0 lg:hidden"
    />
  );
}
