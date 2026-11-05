import { t, useTranslation } from "@/i18n";
import { isLockedIssueStub, LockedIssueChip } from "@/components/LockedIssueChip";
import type { Issue, IssueStatus, IssueLockedStub } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IssueRow } from "@/components/IssueRow";
import { StatusIcon } from "@/components/StatusIcon";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
} from "@/lib/issueDetailBreadcrumb";
import { Link } from "@/lib/router";

export interface TaskDetailRelationItem {
  id: string;
  identifier?: string | null;
  title: string;
  status?: string | null;
  displayStatus?: string | null;
}

export function RelationNavigationList({
  items,
  emptyMessage,
  ariaLabel,
  issueLinkState,
}: {
  items: (TaskDetailRelationItem | IssueLockedStub)[];
  emptyMessage: string;
  ariaLabel: string;
  issueLinkState?: unknown;
}) {
  useTranslation("task-components");
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5" aria-label={ariaLabel}>
      {items.map((item) => {
        if (isLockedIssueStub(item)) {
          return <li key={item.id} className="px-2 py-2"><LockedIssueChip identifier={item.identifier} /></li>;
        }
        const pathId = item.identifier ?? item.id;
        return (
          <li key={item.id}>
            <Link
              to={createIssueDetailPath(pathId)}
              state={issueLinkState}
              onClickCapture={() => rememberIssueDetailLocationState(pathId, issueLinkState)}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`${item.identifier ? `${item.identifier} — ` : ""}${item.title}`}
            >
              {item.status ? (
                <StatusIcon status={item.status} displayStatus={item.displayStatus} className="h-3.5 w-3.5 shrink-0" />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.identifier ? (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {item.identifier}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const NEXT_SUBTASK_STATUS_ORDER: IssueStatus[] = [
  "in_progress",
  "in_review",
  "todo",
  "backlog",
  "blocked",
];

export function resolveTaskDetailSubtaskState(items: Issue[]) {
  const nextAction = NEXT_SUBTASK_STATUS_ORDER
    .map((status) => items.find((item) => item.status === status))
    .find((item): item is Issue => Boolean(item)) ?? null;
  const rootBlocker = nextAction?.status === "blocked"
    ? nextAction.blockerAttention?.terminalBlocker ?? null
    : null;

  return {
    nextAction,
    rootBlocker,
    remainingItems: nextAction
      ? items.filter((item) => item.id !== nextAction.id)
      : items,
  };
}

export function TaskDetailTaskList({
  items,
  ariaLabel,
  issueLinkState,
}: {
  items: Issue[];
  ariaLabel: string;
  issueLinkState?: unknown;
}) {
  useTranslation("task-components");
  return (
    <ul className="flex flex-col gap-0.5" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.id}>
          <IssueRow
            issue={item}
            issueLinkState={issueLinkState}
            presentation="task"
            className="rounded-md"
          />
        </li>
      ))}
    </ul>
  );
}

export function TaskDetailSubtasksPanel({
  items,
  onAddSubtask,
  issueLinkState,
}: {
  items: Issue[];
  onAddSubtask?: () => void;
  issueLinkState?: unknown;
}) {
  useTranslation("task-components");
  const completed = items.filter((item) => item.status === "done").length;
  const progress = items.length > 0 ? Math.round((completed / items.length) * 100) : 0;
  const { nextAction, rootBlocker, remainingItems } = resolveTaskDetailSubtaskState(items);
  const allCompleted = items.length > 0 && completed === items.length;

  return (
    <section className="flex flex-col gap-4" aria-label={t("task-components:subtasks_7eff0a19")}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{t("task-components:progress_4664827f")}</span>
          <span className="font-mono">{t("task-components:sentence_c287954d1161", { value1: completed, value2: items.length })}</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={t("task-components:subtaskCompletion_7e7ba512")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full rounded-full bg-(--status-task-icon-done) transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {rootBlocker ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="task-root-blocker-heading">
          <h3 id="task-root-blocker-heading" className="text-xs font-medium text-muted-foreground">{t("task-components:rootBlocker_9c1c8ef5")}</h3>
          <RelationNavigationList
            items={[rootBlocker]}
            emptyMessage=""
            ariaLabel={t("final-components-b:task-detail.TaskDetailRelationsPanel.Root_blocker_9c1c8e")}
            issueLinkState={issueLinkState}
          />
        </section>
      ) : null}

      {nextAction ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="task-next-action-heading">
          <h3 id="task-next-action-heading" className="text-xs font-medium text-muted-foreground">
            {nextAction.status === "blocked" ? t("task-components:blockedSubtask_6e5a137d") : t("task-components:nextAction_365987d0")}
          </h3>
          <TaskDetailTaskList
            items={[nextAction]}
            ariaLabel={t("final-components-b:task-detail.TaskDetailRelationsPanel.Next_subtask_action_2da726")}
            issueLinkState={issueLinkState}
          />
        </section>
      ) : items.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {allCompleted ? t("task-components:allSubtasksAreComplete_a49f51a5") : t("task-components:noRemainingSubtaskActions_e87f15bb")}
        </p>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("task-components:noSubtasksYet_17d17d5b")}</p>
      )}

      {remainingItems.length > 0 ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="task-other-subtasks-heading">
          <h3 id="task-other-subtasks-heading" className="text-xs font-medium text-muted-foreground">
            {nextAction ? t("task-components:otherSubtasks_087ef068") : t("task-components:subtasks_7eff0a19")}
          </h3>
          <TaskDetailTaskList
            items={remainingItems}
            ariaLabel={nextAction ? t("final-components-b:task-detail.TaskDetailRelationsPanel.Other_subtasks_087ef0") : t("final-components-b:task-detail.TaskDetailRelationsPanel.Subtasks_7eff0a")}
            issueLinkState={issueLinkState}
          />
        </section>
      ) : null}

      {onAddSubtask ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onAddSubtask}>
          <Plus className="h-3.5 w-3.5" />{t("task-components:addSubtask_65db0c29")}</Button>
      ) : null}
    </section>
  );
}

export function TaskDetailReferencesPanel({
  referenced,
  mentionedIn,
  issueLinkState,
}: {
  referenced: TaskDetailRelationItem[];
  mentionedIn: TaskDetailRelationItem[];
  issueLinkState?: unknown;
}) {
  useTranslation("task-components");
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2" aria-labelledby="task-referenced-heading">
        <h3 id="task-referenced-heading" className="text-xs font-medium text-muted-foreground">{t("task-components:referenced_e1ea8a5e")}</h3>
        <RelationNavigationList
          items={referenced}
          emptyMessage={t("task-components:thisTaskDoesNotReferenceAnotherTask_9547804c")}
          ariaLabel={t("final-components-b:task-detail.TaskDetailRelationsPanel.Referenced_tasks_2b2c77")}
          issueLinkState={issueLinkState}
        />
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="task-mentioned-in-heading">
        <h3 id="task-mentioned-in-heading" className="text-xs font-medium text-muted-foreground">{t("task-components:mentionedIn_fb9d60f6")}</h3>
        <RelationNavigationList
          items={mentionedIn}
          emptyMessage={t("task-components:noOtherTaskMentionsThisTask_5ddc410b")}
          ariaLabel={t("final-components-b:task-detail.TaskDetailRelationsPanel.Tasks_that_mention_this_task_178023")}
          issueLinkState={issueLinkState}
        />
      </section>
    </div>
  );
}
