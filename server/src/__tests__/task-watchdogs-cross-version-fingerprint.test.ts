import { describe, expect, it } from "vitest";
import {
  TASK_WATCHDOG_STOP_SNAPSHOT_VERSION,
  classifierWatchdogConfigFromStoredRow,
  classifyTaskWatchdogSubtree,
  isForeignStopSnapshot,
} from "../services/task-watchdogs.ts";
import type {
  TaskWatchdogClassifierIssue,
  TaskWatchdogStopSnapshot,
} from "../services/task-watchdogs.ts";

const companyId = "company-1";
const sourceId = "source-1";
const foreignFingerprint = "task_watchdog_stop:foreign-schema-v1";
const otherFingerprint = "task_watchdog_stop:some-other-state";

type ClassifierInput = Parameters<typeof classifyTaskWatchdogSubtree>[0];
type ClassifierWatchdogConfig = ClassifierInput["watchdog"];

function issue(overrides: Partial<TaskWatchdogClassifierIssue> = {}): TaskWatchdogClassifierIssue {
  return {
    id: sourceId,
    companyId,
    identifier: "IMS-1",
    title: "Stopped subtree",
    // A stopped subtree is made of non-terminal leaves: terminal issues ("done",
    // "cancelled") are not material leaves, so a terminal-only subtree has an empty
    // stop snapshot and any reviewed snapshot with equal waits looks like a shrink
    // of it.
    status: "in_progress",
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    originKind: "manual",
    updatedAt: new Date("2026-09-10T21:18:00.000Z"),
    ...overrides,
  };
}

// Shape written by a server build running the older fingerprint schema: it stores
// `leaves` instead of `materialLeaves`/`waitsByIssueId` and its own version tag.
function foreignStopSnapshot(fingerprint: string) {
  return {
    version: 1,
    fingerprint,
    leaves: [
      {
        issueId: sourceId,
        identifier: "IMS-1",
        title: "Stopped subtree",
        status: "cancelled",
        assignees: [],
        blockers: [],
        waits: [],
      },
    ],
  };
}

// Grace window the service uses before this build takes a row over from a build that
// writes stop snapshots under another schema version (TASK_WATCHDOG_FOREIGN_REVIEW_GRACE_MS).
const foreignReviewGraceMs = 6 * 60 * 60 * 1000;
const justWritten = () => new Date();
const writtenBeforeGraceWindow = () => new Date(Date.now() - foreignReviewGraceMs - 60_000);

function classify(
  watchdog: {
    lastReviewedFingerprint?: string | null;
    lastReviewedStopSnapshot?: unknown;
    lastCompletedAt?: Date | string | null;
    updatedAt?: Date | string | null;
  } = {},
) {
  return classifyTaskWatchdogSubtree({
    watchdog: {
      companyId,
      issueId: sourceId,
      lastReviewedFingerprint: null,
      ...watchdog,
    } as ClassifierWatchdogConfig,
    issues: [issue()],
  });
}

type StoredWatchdogRow = Parameters<typeof classifierWatchdogConfigFromStoredRow>[0];

// Stand-in for a row loaded from `issue_watchdogs`: the stored snapshot keeps the jsonb
// value exactly as Postgres returns it, which is what the service passes on. `seenAt`
// controls how long ago the row was written, i.e. whether the build that owns the
// foreign review is still considered alive.
function storedWatchdogRow(
  lastReviewedStopSnapshot: unknown,
  seenAt: { lastCompletedAt?: Date | null; updatedAt?: Date } = {},
) {
  return {
    id: "watchdog-1",
    companyId,
    issueId: sourceId,
    watchdogAgentId: "agent-1",
    instructions: null,
    status: "active",
    watchdogIssueId: null,
    lastObservedFingerprint: null,
    lastReviewedFingerprint: foreignFingerprint,
    lastTriggeredAt: null,
    lastCompletedAt: seenAt.lastCompletedAt ?? null,
    triggerCount: 1,
    createdAt: new Date("2026-09-10T21:00:00.000Z"),
    updatedAt: seenAt.updatedAt ?? new Date("2026-09-10T21:00:00.000Z"),
    lastReviewedStopSnapshot,
  } as unknown as StoredWatchdogRow;
}

// Classifies through the same conversion the service uses for stored watchdog rows.
function classifyStoredRow(
  lastReviewedStopSnapshot: unknown,
  seenAt: { lastCompletedAt?: Date | null; updatedAt?: Date } = {},
) {
  return classifyTaskWatchdogSubtree({
    watchdog: classifierWatchdogConfigFromStoredRow(
      storedWatchdogRow(lastReviewedStopSnapshot, seenAt),
    ),
    issues: [issue()],
  });
}

describe("task watchdog stop fingerprints written under another schema version", () => {
  it("recognizes a stored snapshot that carries a foreign schema version", () => {
    expect(isForeignStopSnapshot(null)).toBe(false);
    expect(isForeignStopSnapshot(undefined)).toBe(false);
    expect(isForeignStopSnapshot({
      version: TASK_WATCHDOG_STOP_SNAPSHOT_VERSION,
      fingerprint: otherFingerprint,
    })).toBe(false);
    expect(isForeignStopSnapshot(foreignStopSnapshot(foreignFingerprint))).toBe(true);
    // A snapshot of a future schema version is foreign too, as long as it carries the
    // fields every known version writes.
    expect(isForeignStopSnapshot({
      version: TASK_WATCHDOG_STOP_SNAPSHOT_VERSION + 1,
      fingerprint: "task_watchdog_stop:future",
      materialLeaves: [],
      waitsByIssueId: {},
    })).toBe(true);
    // Snapshots without a version tag are not treated as foreign.
    expect(isForeignStopSnapshot({ fingerprint: otherFingerprint })).toBe(false);
    // A malformed snapshot is not a review this build can trust. It stays unreviewed, so
    // the stopped subtree is verified again instead of being suppressed by junk.
    expect(isForeignStopSnapshot({ version: 1 })).toBe(false);
    expect(isForeignStopSnapshot({ version: 1, fingerprint: "" })).toBe(false);
    expect(isForeignStopSnapshot({ version: 1, fingerprint: foreignFingerprint })).toBe(false);
    expect(isForeignStopSnapshot({ version: 1, fingerprint: foreignFingerprint, leaves: "nope" })).toBe(false);
  });

  it("verifies a stopped subtree again when the stored foreign snapshot is malformed", () => {
    const malformed = { version: 1, fingerprint: foreignFingerprint };

    const result = classify({
      lastReviewedFingerprint: foreignFingerprint,
      lastReviewedStopSnapshot: malformed,
      lastCompletedAt: justWritten(),
    });

    expect(result.state).toBe("stopped");
  });

  it("treats a stop reviewed by another schema version as reviewed while that build still writes the row", () => {
    const result = classify({
      lastReviewedFingerprint: foreignFingerprint,
      lastReviewedStopSnapshot: foreignStopSnapshot(foreignFingerprint),
      lastCompletedAt: justWritten(),
    });

    expect(result.state).toBe("already_reviewed");
    expect(result.reason).toContain("different stop-fingerprint schema version");
  });

  it("takes the stopped subtree over once the foreign review's grace window has passed", () => {
    // Regression (review finding): the foreign-schema branch used to answer
    // "already_reviewed" unconditionally, so a foreign review never expired and this
    // build could never take the row back — the watchdog stayed silent forever on a
    // subtree it had never verified itself.
    const result = classify({
      lastReviewedFingerprint: foreignFingerprint,
      lastReviewedStopSnapshot: foreignStopSnapshot(foreignFingerprint),
      lastCompletedAt: writtenBeforeGraceWindow(),
    });

    expect(result.state).toBe("stopped");
    expect(result.reason).toBe("No issue in the watched subtree has a live execution path.");
  });

  it("takes the stopped subtree over when the foreign row carries no readable timestamp", () => {
    const result = classify({
      lastReviewedFingerprint: foreignFingerprint,
      lastReviewedStopSnapshot: foreignStopSnapshot(foreignFingerprint),
      lastCompletedAt: null,
      updatedAt: null,
    });

    expect(result.state).toBe("stopped");
  });

  it("keeps a foreign review fresh when the newest write is an observation timestamp", () => {
    // The other build reviewed the stop a while ago and then refreshed the row with a new
    // observation. Both timestamps move on a write and either one can be the newer value,
    // so the row must not look stale: an early take-over would wake the agent again.
    const result = classify({
      lastReviewedFingerprint: foreignFingerprint,
      lastReviewedStopSnapshot: foreignStopSnapshot(foreignFingerprint),
      lastCompletedAt: writtenBeforeGraceWindow(),
      updatedAt: justWritten(),
    });

    expect(result.state).toBe("already_reviewed");
  });

  it("keeps a foreign stored snapshot readable on the production input path", () => {
    // Regression: the service used to pre-parse the stored snapshot under this build's
    // schema, which turned a foreign snapshot into null before the classifier could
    // inspect it. The production conversion must pass the stored value on unchanged.
    const result = classifyStoredRow(foreignStopSnapshot(foreignFingerprint), {
      lastCompletedAt: justWritten(),
    });

    expect(result.state).toBe("already_reviewed");
    expect(result.reason).toContain("different stop-fingerprint schema version");
  });

  it("takes a foreign stored snapshot over through the production input path after the window", () => {
    const result = classifyStoredRow(foreignStopSnapshot(foreignFingerprint), {
      lastCompletedAt: writtenBeforeGraceWindow(),
    });

    expect(result.state).toBe("stopped");
  });

  it("still triggers for a stored snapshot written under this schema version", () => {
    const ownSnapshot: TaskWatchdogStopSnapshot = {
      version: TASK_WATCHDOG_STOP_SNAPSHOT_VERSION,
      fingerprint: otherFingerprint,
      materialLeaves: [],
      waitsByIssueId: {},
    };

    const result = classifyStoredRow(ownSnapshot);

    expect(result.state).toBe("stopped");
  });

  it("still reports a stopped subtree when the reviewed state belongs to this build", () => {
    const result = classify({
      lastReviewedFingerprint: otherFingerprint,
      lastReviewedStopSnapshot: {
        version: TASK_WATCHDOG_STOP_SNAPSHOT_VERSION,
        fingerprint: otherFingerprint,
        materialLeaves: [],
        waitsByIssueId: {},
      },
    });

    expect(result.state).toBe("stopped");
  });

  it("keeps a same-version reviewed stop reviewed with the original reason", () => {
    const first = classify();
    expect(first.state).toBe("stopped");
    if (first.state !== "stopped") return;

    const second = classify({
      lastReviewedFingerprint: first.stopFingerprint,
      lastReviewedStopSnapshot: first.stopSnapshot,
    });

    expect(second.state).toBe("already_reviewed");
    expect(second.reason).toBe(
      "The current stopped subtree fingerprint was already reviewed by the watchdog.",
    );
  });

  it("writes, parses and classifies exactly the schema version it declares", () => {
    const result = classify();
    expect(result.state).toBe("stopped");
    if (result.state !== "stopped") return;

    // Compile-time guard: the snapshot type and the declared version are the same
    // source of truth, so the constant cannot drift away from the snapshot shape.
    const declaredVersion: typeof TASK_WATCHDOG_STOP_SNAPSHOT_VERSION = result.stopSnapshot.version;
    expect(declaredVersion).toBe(TASK_WATCHDOG_STOP_SNAPSHOT_VERSION);
    expect(isForeignStopSnapshot(result.stopSnapshot)).toBe(false);

    // Round-trip guard: the parser accepts what this build writes. The comparison below
    // can only report "reviewed" when the stored snapshot parsed under this schema,
    // because the shrink comparison needs the parsed reviewed snapshot.
    const roundTrip = classify({
      lastReviewedFingerprint: otherFingerprint,
      lastReviewedStopSnapshot: result.stopSnapshot,
    });
    expect(roundTrip.state).toBe("already_reviewed");
  });
});
