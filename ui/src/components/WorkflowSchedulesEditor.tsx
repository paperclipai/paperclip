import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, MoreHorizontal, Pencil, Plus, Save, Trash2 } from "lucide-react";
import type { WorkflowSchedule } from "@paperclipai/shared";
import type { WorkflowScheduleMutationInput } from "../api/workflows";
import { describeSchedule, ScheduleEditor } from "./ScheduleEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

type ScheduleDraft = WorkflowScheduleMutationInput;

const defaultDraft: ScheduleDraft = {
  title: "",
  cronExpression: "0 9 * * *",
  templateMarkdown: "",
};

function toDraft(schedule: WorkflowSchedule): ScheduleDraft {
  return {
    title: schedule.title,
    cronExpression: schedule.cronExpression,
    templateMarkdown: schedule.templateMarkdown,
    status: schedule.status,
  };
}

export function WorkflowSchedulesEditor({
  schedules,
  onCreate,
  onUpdate,
  onDelete,
  pendingScheduleId = null,
  createPending = false,
}: {
  schedules: readonly WorkflowSchedule[];
  onCreate: (input: WorkflowScheduleMutationInput) => void;
  onUpdate: (scheduleId: string, input: Partial<WorkflowScheduleMutationInput>) => Promise<void>;
  onDelete: (scheduleId: string) => void;
  pendingScheduleId?: string | null;
  createPending?: boolean;
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(defaultDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingSchedule = useMemo(
    () => schedules.find((schedule) => schedule.id === editingId) ?? null,
    [editingId, schedules],
  );
  const [editDraft, setEditDraft] = useState<ScheduleDraft | null>(null);

  useEffect(() => {
    if (!editingSchedule) {
      setEditDraft(null);
      return;
    }
    setEditDraft(toDraft(editingSchedule));
  }, [editingSchedule]);

  function startEditing(schedule: WorkflowSchedule) {
    setEditingId(schedule.id);
    setEditDraft(toDraft(schedule));
  }

  function cancelEditing() {
    setEditingId(null);
    setEditDraft(null);
  }

  return (
    <Card className="overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-sm gap-4 py-5">
      <CardHeader className="space-y-1">
        <CardTitle className="text-sm font-semibold">Workflow schedules</CardTitle>
        <div className="text-xs text-muted-foreground">
          Board-managed cron schedules. The workflow receives only the rendered markdown body when a schedule fires.
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 rounded-2xl border border-border/60 bg-background/40 p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">New schedule</div>
              <Input
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Daily brief"
              />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">When</div>
              <ScheduleEditor
                value={draft.cronExpression}
                onChange={(cronExpression) =>
                  setDraft((current) => ({ ...current, cronExpression }))
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Markdown body</div>
            <Textarea
              value={draft.templateMarkdown}
              onChange={(event) =>
                setDraft((current) => ({ ...current, templateMarkdown: event.target.value }))
              }
              rows={6}
              placeholder="Write the exact body that Bizbox should send when this schedule fires."
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Timezone is fixed to UTC. Missed fires are skipped.
            </div>
            <Button
              onClick={() => onCreate(draft)}
              disabled={createPending || !draft.title.trim() || !draft.cronExpression.trim() || !draft.templateMarkdown.trim()}
            >
              {createPending ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
              Create schedule
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {schedules.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
              No workflow schedules yet.
            </div>
          ) : (
            schedules.map((schedule) => {
              const isEditing = editingId === schedule.id;
              const isPending = pendingScheduleId === schedule.id;
              const nextStatus = schedule.status === "active" ? "paused" : "active";
              return (
                <div
                  key={schedule.id}
                  className={cn(
                    "rounded-2xl border border-border/70 bg-background/40 p-4",
                    isEditing && "border-cyan-500/40 bg-cyan-500/5",
                  )}
                >
                  {!isEditing ? (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-semibold">{schedule.title}</div>
                            <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                              {schedule.status}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {describeSchedule(schedule.cronExpression)}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isPending}
                            onClick={() => startEditing(schedule)}
                          >
                            <Pencil className="mr-1.5 h-4 w-4" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isPending}
                            onClick={() => onUpdate(schedule.id, { status: nextStatus })}
                          >
                            <MoreHorizontal className="mr-1.5 h-4 w-4" />
                            {schedule.status === "active" ? "Pause" : "Resume"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            disabled={isPending}
                            onClick={() => {
                              if (window.confirm(`Delete schedule "${schedule.title}"?`)) {
                                onDelete(schedule.id);
                              }
                            }}
                          >
                            <Trash2 className="mr-1.5 h-4 w-4" />
                            Delete
                          </Button>
                        </div>
                      </div>

                      <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                        <div>Next run: {schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "None"}</div>
                        <div>Last fired: {schedule.lastFiredAt ? relativeTime(schedule.lastFiredAt) : "Never"}</div>
                      </div>

                      <div className="rounded-xl border border-border/60 bg-neutral-950 p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-words">
                        {schedule.templateMarkdown}
                      </div>
                    </div>
                  ) : editDraft ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                        <div className="space-y-2">
                          <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Title</div>
                          <Input
                            value={editDraft.title}
                            onChange={(event) =>
                              setEditDraft((current) => current ? { ...current, title: event.target.value } : current)
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Status</div>
                          <select
                            value={editDraft.status ?? schedule.status}
                            onChange={(event) =>
                              setEditDraft((current) =>
                                current ? { ...current, status: event.target.value } : current
                              )
                            }
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          >
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                            <option value="archived">Archived</option>
                          </select>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">When</div>
                        <ScheduleEditor
                          value={editDraft.cronExpression}
                          onChange={(cronExpression) =>
                            setEditDraft((current) => current ? { ...current, cronExpression } : current)
                          }
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Markdown body</div>
                        <Textarea
                          value={editDraft.templateMarkdown}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current ? { ...current, templateMarkdown: event.target.value } : current
                            )
                          }
                          rows={6}
                        />
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        <Button type="button" variant="outline" onClick={cancelEditing}>
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          disabled={!editDraft.title.trim() || !editDraft.cronExpression.trim() || !editDraft.templateMarkdown.trim()}
                          onClick={() => {
                            void onUpdate(schedule.id, editDraft).then(() => {
                              cancelEditing();
                            }).catch(() => {});
                          }}
                        >
                          <Save className="mr-1.5 h-4 w-4" />
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
