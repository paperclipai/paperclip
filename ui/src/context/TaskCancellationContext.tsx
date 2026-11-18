import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { bindAccount } from "@/lib/account-scope";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SubtaskCancellationChoice = "task_only" | "subtasks" | "dismiss";
type Subtask = Pick<Issue, "id" | "identifier" | "title">;
type ConfirmCancellation = (subtasks: Subtask[]) => Promise<SubtaskCancellationChoice>;
const TaskCancellationContext = createContext<ConfirmCancellation | null>(null);

/** Keep the confirmation mounted across task navigation and list refreshes. */
export function TaskCancellationProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [subtasks, setSubtasks] = useState<Subtask[] | null>(null);
  const resolveRef = useRef<((choice: SubtaskCancellationChoice) => void) | null>(null);
  const accountRef = useRef<ReturnType<typeof bindAccount> | null>(null);
  const finish = useCallback((choice: SubtaskCancellationChoice) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    accountRef.current = null;
    setSubtasks(null);
    resolve?.(choice);
  }, []);
  const confirm = useCallback<ConfirmCancellation>((tasks) => {
    // A second request replaces, rather than accepts, an unanswered prompt.
    resolveRef.current?.("dismiss");
    accountRef.current = bindAccount(client);
    setSubtasks(tasks);
    return new Promise(resolve => { resolveRef.current = resolve; });
  }, [client]);
  useEffect(() => {
    bindAccount(client);
    const unsubscribe = client.getQueryCache().subscribe(() => {
      if (accountRef.current && !accountRef.current.isCurrentScope()) finish("dismiss");
    });
    return () => { unsubscribe(); resolveRef.current?.("dismiss"); };
  }, [client, finish]);

  return (
    <TaskCancellationContext.Provider value={confirm}>
      {children}
      <Dialog open={subtasks !== null} onOpenChange={open => { if (!open) finish("dismiss"); }}>
        <DialogContent className="max-h-(--sz-calc-18) overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Cancel active subtasks?</DialogTitle>
            <DialogDescription>
              This task has {subtasks?.length ?? 0} active {(subtasks?.length ?? 0) === 1 ? "subtask" : "subtasks"}. Would you like to cancel {(subtasks?.length ?? 0) === 1 ? "it" : "those"} as well?
            </DialogDescription>
          </DialogHeader>
          <ul aria-label="Active subtasks" className="flex flex-col gap-2 text-sm">
            {subtasks?.map(task => (
              <li key={task.id} className="flex min-w-0 items-start gap-2">
                {task.identifier ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.identifier}</span> : null}
                <span className="min-w-0 break-words">{task.title}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => finish("task_only")}>Cancel task only</Button>
            <Button variant="destructive" onClick={() => finish("subtasks")}>Cancel task and subtasks</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TaskCancellationContext.Provider>
  );
}

export function useConfirmTaskCancellation() {
  return useContext(TaskCancellationContext);
}
