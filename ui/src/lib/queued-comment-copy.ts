
export const QUEUED_COMPOSER_LIVE_RUN_LEAD = "Visible as soon as you send.";
export const QUEUED_COMPOSER_LIVE_RUN_DETAIL =
  "The running agent can read it now; its next turn starts after this run.";

export const QUEUED_COMPOSER_EDIT_LEAD = "Already visible.";
export const QUEUED_COMPOSER_EDIT_DETAIL =
  "Saving replaces the text in the thread and the next turn. It can’t undo earlier reads or actions.";

export const QUEUED_ROW_HEADER_LEAD = "Visible now · queued for the next turn";
export const QUEUED_ROW_HEADER_LEAD_SAVING = "Visible once saved · queued for the next turn";
export const QUEUED_ROW_SAVING = "Saving…";
export const QUEUED_ROW_HEADER_DETAIL =
  "Edit or delete changes the thread and the next turn. It can’t undo earlier reads or actions.";

export const QUEUED_DISCARD_TITLE = "Delete and remove from the next turn";
export const queuedDiscardLabel = (body: string) =>
  `Delete queued message and remove it from the next turn: ${body}`;
export const QUEUED_CANCEL_SAVING_TITLE = "Cancel sending and restore to the composer";
export const queuedCancelSavingLabel = (body: string) =>
  `Cancel sending and restore to the composer: ${body}`;

export const QUEUED_INTERRUPT_TITLE_ACTIVE =
  "Stop the current run and start the next turn with queued messages";
export const QUEUED_INTERRUPT_TITLE_IDLE = "Start the next turn with queued messages now";

export const QUEUED_INTERRUPT_REQUESTED =
  "Interrupt requested. The next turn starts with queued messages once the current run stops.";
export const QUEUED_DISCARDED =
  "Queued message deleted. Earlier reads or actions can’t be undone.";
export const QUEUED_CANCEL_REQUESTED =
  "Cancel requested. Text is back in the composer.";
export const QUEUED_LATE_DISCARD =
  "Too late to delete: it’s past the point where it can be withdrawn. It stays in the thread.";
export const QUEUED_DEFERRED_STATUS =
  "Still queued for the next turn. It starts when the task is ready.";
export const QUEUED_DISCARD_FAILED = "Couldn’t delete. Message is still queued and visible.";

export const QUEUED_DISCARDED_TOAST = {
  title: "Queued message deleted",
  body: "Removed from the thread and the next turn. Earlier reads or actions can’t be undone.",
} as const;
export const QUEUED_EDITED_TOAST = {
  title: "Queued message updated",
  body: "The thread and the next turn now use the new text. Earlier reads or actions can’t be undone.",
} as const;
export const QUEUED_LATE_DISCARD_TOAST = {
  title: "Too late to delete",
  body: "This message is past the point where it can be withdrawn. It stays in the thread.",
} as const;
export const QUEUED_CANCEL_REQUESTED_TOAST = {
  title: "Cancel requested",
  body: "Text is back in the composer. A saved copy, if any, is removed once the server confirms. Earlier reads or actions can’t be undone.",
} as const;
export const QUEUED_CANCEL_FAILED_TOAST = {
  title: "Cancellation unconfirmed",
  body: "We could not confirm removal. A submitted copy may still be visible. The composer holds a copy; sending again may create a duplicate. Earlier reads or actions can’t be undone.",
} as const;
export const QUEUED_CANCELED_TOAST = {
  title: "Queued comment canceled",
  body: "Removed from the thread and restored to the composer. Earlier reads or actions can’t be undone.",
} as const;
