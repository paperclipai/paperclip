import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { useConfirmTaskCancellation } from "@/context/TaskCancellationContext";
import { bindAccount } from "@/lib/account-scope";
import { queryKeys } from "@/lib/queryKeys";

export class TaskCancellationDismissedError extends Error {
  constructor() { super("Task cancellation dismissed"); this.name = "AbortError"; }
}

export class SubtaskCancellationError extends Error {}

const active = (task: Issue) => task.status !== "done" && task.status !== "cancelled";

export function useTaskCancellation() {
  const confirm = useConfirmTaskCancellation();
  const client = useQueryClient();
  return useCallback(async (
    id: string,
    data: Record<string, unknown>,
    beforeCancel?: () => Promise<unknown>,
  ) => {
    const account = bindAccount(client);
    const assertCurrentAccount = () => {
      if (!account.isCurrentAccount()) throw new TaskCancellationDismissedError();
    };
    await account.whenAccountReady();
    assertCurrentAccount();
    const root = await issuesApi.getCore(id, { cache: "no-store" });
    assertCurrentAccount();
    const filters = { descendantOf: root.id, includeAgentCreatedTasks: true, includeRoutineExecutions: true };
    const subtasks = (await issuesApi.listAll(root.companyId, filters, { cache: "no-store" })).filter(active);
    assertCurrentAccount();
    if (subtasks.length && !confirm) throw new Error("Task cancellation is unavailable. Refresh and try again.");
    const choice = subtasks.length ? await confirm!(subtasks) : "task_only";
    assertCurrentAccount();
    if (choice === "dismiss") throw new TaskCancellationDismissedError();
    await beforeCancel?.();
    assertCurrentAccount();
    const result = await issuesApi.update(id, data);
    assertCurrentAccount();
    if (choice === "task_only") return result;

    const confirmedIds = new Set(subtasks.map(task => task.id));
    let remaining: Issue[];
    try {
      remaining = (await issuesApi.listAll(root.companyId, filters, { cache: "no-store" }))
        .filter(task => confirmedIds.has(task.id) && active(task));
    } catch (error) {
      assertCurrentAccount();
      throw new SubtaskCancellationError("The task was canceled, but its subtasks could not be refreshed. Try canceling them again.", { cause: error });
    }
    assertCurrentAccount();
    const failed: string[] = [];
    for (const task of remaining) {
      assertCurrentAccount();
      try {
        const current = await issuesApi.getCore(task.id, { cache: "no-store" });
        assertCurrentAccount();
        if (current.parentId === task.parentId && active(current)) await issuesApi.update(task.id, { status: "cancelled" });
      } catch (error) {
        assertCurrentAccount();
        failed.push(task.identifier ?? task.title);
      } finally {
        if (account.isCurrentAccount()) {
          void client.invalidateQueries({ queryKey: queryKeys.issues.detail(task.id) });
          if (task.identifier) void client.invalidateQueries({ queryKey: queryKeys.issues.detail(task.identifier) });
        }
      }
    }
    assertCurrentAccount();
    void client.invalidateQueries({ queryKey: queryKeys.issues.list(root.companyId) });
    if (failed.length) throw new SubtaskCancellationError(`The task was canceled, but these subtasks could not be canceled: ${failed.join(", ")}. Try canceling them again.`);
    return result;
  }, [client, confirm]);
}
