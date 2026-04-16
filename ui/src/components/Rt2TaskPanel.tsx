import { useEffect, useState } from "react";
import type { Rt2AssignableUser, Rt2TaskDetail } from "../api/rt2-tasks";
import { Button } from "@/components/ui/button";

export function Rt2TaskPanel({
  detail,
  assignableUsers,
  onJoin,
  onAssignParticipant,
  onChangeCapacity,
  onEndParticipant,
  onCreateTodo,
  onStartTodo,
}: {
  detail: Rt2TaskDetail;
  assignableUsers: Rt2AssignableUser[];
  onJoin: () => void;
  onAssignParticipant: (userId: string) => void;
  onChangeCapacity: (nextCapacity: number, endedUserIds: string[]) => void;
  onEndParticipant: (userId: string, reason: "manager_removed" | "self_left" | "capacity_reduced") => void;
  onCreateTodo: () => void;
  onStartTodo: (todoIssueId: string) => void;
}) {
  const activeParticipants = detail.participants.filter((participant) => participant.state === "active");
  const [selectedAssignableUserId, setSelectedAssignableUserId] = useState(assignableUsers[0]?.userId ?? "");

  useEffect(() => {
    if (assignableUsers.some((user) => user.userId === selectedAssignableUserId)) {
      return;
    }
    setSelectedAssignableUserId(assignableUsers[0]?.userId ?? "");
  }, [assignableUsers, selectedAssignableUserId]);

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">RT2 Task Engine</h3>
          <p className="text-xs text-muted-foreground">
            {detail.activeParticipantCount} / {detail.capacity} participants
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onJoin}>Join</Button>
          <Button size="sm" variant="outline" onClick={onCreateTodo}>New To-Do</Button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Assign participant</span>
        <select
          className="min-w-40 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={selectedAssignableUserId}
          onChange={(event) => setSelectedAssignableUserId(event.target.value)}
        >
          {assignableUsers.length === 0 ? (
            <option value="">No available users</option>
          ) : (
            assignableUsers.map((user) => (
              <option key={user.userId} value={user.userId}>
                {user.userId}
              </option>
            ))
          )}
        </select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (!selectedAssignableUserId) return;
            onAssignParticipant(selectedAssignableUserId);
          }}
        >
          Assign
        </Button>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Capacity</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChangeCapacity(detail.capacity + 1, [])}
        >
          +1
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const nextCapacity = Math.max(1, detail.capacity - 1);
            const overflow = Math.max(0, activeParticipants.length - nextCapacity);
            const endedUserIds = overflow > 0
              ? activeParticipants.slice(-overflow).map((participant) => participant.userId)
              : [];
            onChangeCapacity(nextCapacity, endedUserIds);
          }}
        >
          -1
        </Button>
      </div>

      <div className="space-y-2">
        {detail.participants.map((participant) => (
          <div key={participant.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <div className="text-sm font-medium">{participant.userId}</div>
              <div className="text-xs text-muted-foreground">
                {participant.state === "active" ? "active" : participant.endedReason ?? "ended"}
              </div>
            </div>
            {participant.state === "active" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onEndParticipant(participant.userId, "manager_removed")}
              >
                End
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        {detail.todos.map((todo) => (
          <div key={todo.issueId} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <div className="text-sm font-medium">{todo.title}</div>
              <div className="text-xs text-muted-foreground">
                {todo.assigneeUserId ?? "unassigned"} · {todo.submittedDeliverableCount} / {todo.deliverableCount} deliverables
              </div>
            </div>
            {todo.status === "todo" ? (
              <Button size="sm" variant="outline" onClick={() => onStartTodo(todo.issueId)}>
                Start
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        {detail.deliverables.map((deliverable) => (
          <div key={deliverable.workProductId} className="rounded-lg border border-border px-3 py-2">
            <div className="text-sm font-medium">{deliverable.title}</div>
            <div className="text-xs text-muted-foreground">{deliverable.state}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
