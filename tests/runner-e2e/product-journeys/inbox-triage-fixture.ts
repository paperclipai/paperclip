/** Ordinary user-owned relevant activity for an archived inbox task. */
export function inboxBlockedActivity(userId: string) {
  return {
    status: "blocked" as const,
    unblockDescriptor: {
      owner: { userId },
      action: "Review the QA inbox task before continuing.",
    },
  };
}
