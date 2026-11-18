import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  LinkResponsibility,
  ResponsibilityArea,
  ResponsibilityLooseWork,
  ResponsibilityWithRollup,
} from "@paperclipai/shared";
import { FolderOpen, Repeat } from "lucide-react";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { EntityRow } from "@/components/EntityRow";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { queryKeys } from "@/lib/queryKeys";
import { describeNextDue, groupByArea, routinePath } from "@/lib/responsibilities";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { issueUrl, projectUrl } from "@/lib/utils";
import { GiveToAgentMenu } from "./GiveToAgent";

/** How many of each kind show before "Show all". */
const PREVIEW_COUNT = 5;

type AreaRef = Pick<ResponsibilityArea, "id" | "title" | "status">;

interface FileTarget {
  label: string;
  body: LinkResponsibility;
}

/**
 * "File under…": put a loose project, task or routine under one of your
 * responsibilities. Offered quietly; leaving work loose is fine.
 */
function FileUnderMenu({
  target,
  responsibilities,
  areas,
  onFiled,
}: {
  target: FileTarget;
  responsibilities: readonly ResponsibilityWithRollup[];
  areas: readonly AreaRef[];
  onFiled: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const groups = useMemo(() => groupByArea(areas, responsibilities), [areas, responsibilities]);
  const file = useMutation({
    mutationFn: (responsibility: ResponsibilityWithRollup) => responsibilitiesApi.link(responsibility.id, target.body),
    onSuccess: (_result, responsibility) => {
      onFiled(`Filed “${target.label}” under ${responsibility.title}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
    },
    onError: (error) => onFiled(`Couldn’t file “${target.label}”. ${describeError(error).body}`),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          disabled={file.isPending}
          aria-label={`File ${target.label} under a responsibility`}
        >
          File under…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-(--sz-50vh) overflow-y-auto">
        {groups.map((group) => (
          <DropdownMenuGroup key={group.area?.id ?? "__none__"}>
            <DropdownMenuLabel>{group.area ? group.area.title : "No area"}</DropdownMenuLabel>
            {group.items.map((responsibility) => (
              <DropdownMenuItem key={responsibility.id} onSelect={() => file.mutate(responsibility)}>
                {responsibility.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LooseList<T>({
  title,
  count,
  items,
  note,
  render,
}: {
  title: string;
  count: number;
  items: readonly T[];
  /** A line under the list, e.g. that the list is capped. */
  note?: string | null;
  render: (item: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, PREVIEW_COUNT);
  const headingId = `loose-${title.toLowerCase()}-heading`;
  return (
    <div className="flex flex-col gap-1" role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-medium text-muted-foreground">
        {title} <span className="tabular-nums">{count}</span>
      </h3>
      <ul className="flex flex-col">{shown.map(render)}</ul>
      {items.length > PREVIEW_COUNT ? (
        <Button size="xs" variant="ghost" className="w-fit text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </Button>
      ) : null}
      {note && (expanded || items.length <= PREVIEW_COUNT) ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/**
 * "Outside your responsibilities": unfinished projects, open tasks and
 * active routines filed under no responsibility, company-wide. Kept quiet:
 * loose work is legitimate, so filing is offered, never asked for. Each item
 * can also be given to an agent.
 */
export function LooseWorkSection({
  companyId,
  loose,
  responsibilities,
  areas,
  agents,
  now,
}: {
  companyId: string;
  loose: ResponsibilityLooseWork;
  /** Agents an item can be given to. */
  agents: readonly Agent[];
  /** Active responsibilities a loose item could be filed under. */
  responsibilities: readonly ResponsibilityWithRollup[];
  areas: readonly AreaRef[];
  now: Date;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  if (loose.projectCount + loose.openTaskCount + loose.routineCount === 0) return null;
  const fileUnder = (target: FileTarget) =>
    responsibilities.length > 0 ? (
      <FileUnderMenu target={target} responsibilities={responsibilities} areas={areas} onFiled={setNotice} />
    ) : null;
  const taskNote = loose.openTaskCount > loose.tasks.length
    ? `Showing the ${loose.tasks.length} most recently updated of ${loose.openTaskCount} open tasks.`
    : null;

  return (
    <section aria-labelledby="loose-work-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="loose-work-heading" className="text-base font-semibold text-foreground">
          Outside your responsibilities
        </h2>
        <p className="text-sm text-muted-foreground">
          Work in the company that is not filed under a responsibility. Not everything needs to be: a daily standup
          or a one-off errand can live here.
        </p>
      </div>
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {loose.projectCount > 0 ? (
        <LooseList
          title="Projects"
          count={loose.projectCount}
          items={loose.projects}
          render={(project) => {
            const due = describeNextDue(project.targetDate, now);
            return (
              <li key={project.id} className="flex items-center gap-1 pr-2">
                <div className="min-w-0 flex-1">
                  <EntityRow
                    className="border-b-0"
                    leading={<FolderOpen className="size-4 text-muted-foreground" aria-hidden="true" />}
                    title={project.name}
                    to={projectUrl(project)}
                    meta={due ? <span className="text-xs tabular-nums text-muted-foreground">Due {due.label}</span> : null}
                    trailing={<StatusBadge status={project.status} />}
                  />
                </div>
                <GiveToAgentMenu companyId={companyId} agents={agents} size="icon-xs" item={{ kind: "project", id: project.id, label: project.name, currentAgentId: project.leadAgentId }} />
                {fileUnder({ label: project.name, body: { projectId: project.id } })}
              </li>
            );
          }}
        />
      ) : null}
      {loose.openTaskCount > 0 ? (
        <LooseList
          title="Open tasks"
          count={loose.openTaskCount}
          items={loose.tasks}
          note={taskNote}
          render={(task) => (
            <li key={task.id} className="flex items-center gap-1 pr-2">
              <div className="min-w-0 flex-1">
                <EntityRow
                  className="border-b-0"
                  leading={<StatusIcon {...taskStatusIconProps(task)} />}
                  identifier={task.identifier ?? undefined}
                  title={task.title}
                  to={issueUrl(task)}
                />
              </div>
              <GiveToAgentMenu companyId={companyId} agents={agents} size="icon-xs" item={{ kind: "task", id: task.id, label: task.title, currentAgentId: task.assigneeAgentId }} />
              {fileUnder({ label: task.title, body: { issueId: task.id } })}
            </li>
          )}
        />
      ) : null}
      {loose.routineCount > 0 ? (
        <LooseList
          title="Routines"
          count={loose.routineCount}
          items={loose.routines}
          render={(routine) => (
            <li key={routine.id} className="flex items-center gap-1 pr-2">
              <div className="min-w-0 flex-1">
                <EntityRow
                  className="border-b-0"
                  leading={<Repeat className="size-4 text-muted-foreground" aria-hidden="true" />}
                  title={routine.title}
                  to={routinePath(routine.id)}
                  trailing={<StatusBadge status={routine.status} />}
                />
              </div>
              <GiveToAgentMenu companyId={companyId} agents={agents} size="icon-xs" item={{ kind: "routine", id: routine.id, label: routine.title, currentAgentId: routine.assigneeAgentId }} />
              {fileUnder({ label: routine.title, body: { routineId: routine.id } })}
            </li>
          )}
        />
      ) : null}
    </section>
  );
}
