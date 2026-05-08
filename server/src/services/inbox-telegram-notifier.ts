export interface InboxBadgeSnapshot {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
}

export interface InboxTelegramNotifierState {
  lastObservedInboxCount: number | null;
  lastObservedAt: string | null;
  lastNotifiedInboxCount: number | null;
  lastNotifiedAt: string | null;
}

export interface NotificationDecision {
  shouldNotify: boolean;
  reason: "initial_positive" | "count_changed" | "no_action_needed";
  nextState: InboxTelegramNotifierState;
}

export interface NotificationMessageOptions {
  companyLabel: string;
  inboxUrl?: string | null;
  observedAt: string;
}

export function createDefaultInboxTelegramNotifierState(): InboxTelegramNotifierState {
  return {
    lastObservedInboxCount: null,
    lastObservedAt: null,
    lastNotifiedInboxCount: null,
    lastNotifiedAt: null,
  };
}

export function normalizeInboxBadgeSnapshot(input: Partial<InboxBadgeSnapshot>): InboxBadgeSnapshot {
  return {
    inbox: normalizeCount(input.inbox),
    approvals: normalizeCount(input.approvals),
    failedRuns: normalizeCount(input.failedRuns),
    joinRequests: normalizeCount(input.joinRequests),
  };
}

export function deriveInboxAlertCount(snapshot: InboxBadgeSnapshot): number {
  return Math.max(0, snapshot.inbox - snapshot.failedRuns - snapshot.joinRequests - snapshot.approvals);
}

export function decideInboxTelegramNotification(params: {
  previousState?: Partial<InboxTelegramNotifierState> | null;
  snapshot: Partial<InboxBadgeSnapshot>;
  observedAt: string;
}): NotificationDecision {
  const snapshot = normalizeInboxBadgeSnapshot(params.snapshot);
  const previousState = normalizeState(params.previousState);
  const previousCount = previousState.lastObservedInboxCount;
  const currentCount = snapshot.inbox;

  const nextState: InboxTelegramNotifierState = {
    ...previousState,
    lastObservedInboxCount: currentCount,
    lastObservedAt: params.observedAt,
  };

  if (currentCount <= 0) {
    return {
      shouldNotify: false,
      reason: "no_action_needed",
      nextState,
    };
  }

  if (previousCount === null) {
    return {
      shouldNotify: true,
      reason: "initial_positive",
      nextState: {
        ...nextState,
        lastNotifiedInboxCount: currentCount,
        lastNotifiedAt: params.observedAt,
      },
    };
  }

  if (previousCount !== currentCount) {
    return {
      shouldNotify: true,
      reason: "count_changed",
      nextState: {
        ...nextState,
        lastNotifiedInboxCount: currentCount,
        lastNotifiedAt: params.observedAt,
      },
    };
  }

  return {
    shouldNotify: false,
    reason: "no_action_needed",
    nextState,
  };
}

export function formatInboxTelegramMessage(
  snapshotInput: Partial<InboxBadgeSnapshot>,
  options: NotificationMessageOptions,
): string {
  const snapshot = normalizeInboxBadgeSnapshot(snapshotInput);
  const alerts = deriveInboxAlertCount(snapshot);
  const breakdown: string[] = [];

  if (snapshot.failedRuns > 0) {
    breakdown.push(`${snapshot.failedRuns} failed run${snapshot.failedRuns === 1 ? "" : "s"}`);
  }
  if (alerts > 0) {
    breakdown.push(`${alerts} alert${alerts === 1 ? "" : "s"}`);
  }
  if (snapshot.joinRequests > 0) {
    breakdown.push(`${snapshot.joinRequests} join request${snapshot.joinRequests === 1 ? "" : "s"}`);
  }
  if (snapshot.approvals > 0) {
    breakdown.push(`${snapshot.approvals} approval${snapshot.approvals === 1 ? "" : "s"}`);
  }

  const lines = [
    `Paperclip inbox update for ${options.companyLabel}`,
    `Inbox count: ${snapshot.inbox}`,
    `Source: /api/companies/:companyId/sidebar-badges`,
    `Breakdown: ${breakdown.length > 0 ? breakdown.join(", ") : "no actionable badge categories reported"}`,
    `Observed at: ${options.observedAt}`,
  ];

  if (options.inboxUrl) {
    lines.push(`Open inbox: ${options.inboxUrl}`);
  }

  return lines.join("\n");
}

function normalizeState(
  input?: Partial<InboxTelegramNotifierState> | null,
): InboxTelegramNotifierState {
  const base = createDefaultInboxTelegramNotifierState();
  if (!input) return base;
  return {
    lastObservedInboxCount:
      typeof input.lastObservedInboxCount === "number" && Number.isFinite(input.lastObservedInboxCount)
        ? input.lastObservedInboxCount
        : base.lastObservedInboxCount,
    lastObservedAt: typeof input.lastObservedAt === "string" ? input.lastObservedAt : base.lastObservedAt,
    lastNotifiedInboxCount:
      typeof input.lastNotifiedInboxCount === "number" && Number.isFinite(input.lastNotifiedInboxCount)
        ? input.lastNotifiedInboxCount
        : base.lastNotifiedInboxCount,
    lastNotifiedAt: typeof input.lastNotifiedAt === "string" ? input.lastNotifiedAt : base.lastNotifiedAt,
  };
}

function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}
