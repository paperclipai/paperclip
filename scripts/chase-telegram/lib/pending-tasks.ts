export interface PendingTask {
  title: string;
  description: string;
  assigneeName?: string;
  sourceMessage: string;
  createdAt: number;
  awaitingAssign?: boolean;
  originalDraftTitle?: string;
  sourceIssueId?: string;
  sourceIssueIdentifier?: string;
  destructiveAction?: string;
}

const tasks = new Map<number, PendingTask>();

export function setPendingTask(chatId: number, task: PendingTask): void {
  tasks.set(chatId, task);
}

export function getPendingTask(chatId: number): PendingTask | undefined {
  return tasks.get(chatId);
}

export function clearPendingTask(chatId: number): void {
  tasks.delete(chatId);
}
