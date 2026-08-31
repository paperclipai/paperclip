export type InboxDismissalKind = "dismiss" | "snooze";

export interface InboxDismissal {
  id: string;
  companyId: string;
  userId: string;
  itemKey: string;
  kind: InboxDismissalKind;
  dismissedAt: Date;
  snoozedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
