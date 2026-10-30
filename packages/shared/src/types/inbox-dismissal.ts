export type InboxDismissalKind = "dismiss" | "snooze";

export interface InboxDismissal {
  id: string;
  companyId: string;
  userId: string;
  itemKey: string;
  kind: InboxDismissalKind;
  dismissedAt: Date;
  snoozedUntil: Date | null;
  /** The attention card's `changeFingerprint` when it was hidden; `null` for other inbox items. */
  fingerprint: string | null;
  createdAt: Date;
  updatedAt: Date;
}
