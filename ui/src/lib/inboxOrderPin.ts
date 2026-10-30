import type { Issue } from "@paperclipai/shared";
import {
  getInboxWorkItemKey,
  type InboxGroupedSection,
  type InboxWorkItem,
} from "./inbox";
import { INBOX_ARCHIVE_CONFIRMATION_GRACE_MS } from "./inboxArchiveCache";

export interface InboxPinnedKey {
  key: string;
  missingSince: number | null;
}

export interface InboxPinnedSectionOrder extends InboxPinnedKey {
  rows: readonly InboxPinnedKey[];
  childrenByIssueId: ReadonlyMap<string, readonly InboxPinnedKey[]>;
}

export interface InboxOrderPin {
  sections: readonly InboxPinnedSectionOrder[];
}

export interface InboxOrderPinReconcileResult {
  sections: InboxGroupedSection[];
  pin: InboxOrderPin;
}

interface ReconciledKeys {
  entries: InboxPinnedKey[];
  retainedPinnedKeys: ReadonlySet<string>;
  visibleKeys: string[];
}

function inboxOrderRowKey(item: InboxWorkItem): string {
  return item.kind === "issue" ? item.issue.id : getInboxWorkItemKey(item);
}

function captureKeys(keys: Iterable<string>): InboxPinnedKey[] {
  return Array.from(keys, (key) => ({ key, missingSince: null }));
}

function captureSection(section: InboxGroupedSection): InboxPinnedSectionOrder {
  return {
    key: section.key,
    missingSince: null,
    rows: captureKeys(section.displayItems.map(inboxOrderRowKey)),
    childrenByIssueId: new Map(
      Array.from(section.childrenByIssueId, ([issueId, children]) => [
        issueId,
        captureKeys(children.map((child) => child.id)),
      ]),
    ),
  };
}

export function captureInboxOrderPin(
  sections: readonly InboxGroupedSection[],
): InboxOrderPin {
  return { sections: sections.map(captureSection) };
}

function insertionIndexForVisiblePosition(
  entries: readonly InboxPinnedKey[],
  visibleKeys: ReadonlySet<string>,
  visibleIndex: number,
): number {
  let seenVisible = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (seenVisible === visibleIndex) return index;
    if (visibleKeys.has(entries[index]!.key)) seenVisible += 1;
  }
  return entries.length;
}

function reconcileKeys(
  pinned: readonly InboxPinnedKey[],
  freshKeys: readonly string[],
  nowMs: number,
): ReconciledKeys {
  const freshKeySet = new Set(freshKeys);
  const entries = pinned.flatMap((entry): InboxPinnedKey[] => {
    if (freshKeySet.has(entry.key)) {
      return entry.missingSince === null
        || nowMs - entry.missingSince < INBOX_ARCHIVE_CONFIRMATION_GRACE_MS
        ? [{ key: entry.key, missingSince: null }]
        : [];
    }

    const missingSince = entry.missingSince ?? nowMs;
    return nowMs - missingSince < INBOX_ARCHIVE_CONFIRMATION_GRACE_MS
      ? [{ key: entry.key, missingSince }]
      : [];
  });
  const retainedPinnedKeys = new Set(entries.map((entry) => entry.key));

  const visibleKeys = new Set(
    entries
      .filter((entry) => entry.missingSince === null)
      .map((entry) => entry.key),
  );

  freshKeys.forEach((key, freshIndex) => {
    if (retainedPinnedKeys.has(key)) return;
    const insertionIndex = insertionIndexForVisiblePosition(entries, visibleKeys, freshIndex);
    entries.splice(insertionIndex, 0, { key, missingSince: null });
    visibleKeys.add(key);
  });

  return {
    entries,
    retainedPinnedKeys,
    visibleKeys: entries
      .filter((entry) => entry.missingSince === null)
      .map((entry) => entry.key),
  };
}

function reconcileChildren(
  pinned: ReadonlyMap<string, readonly InboxPinnedKey[]>,
  fresh: ReadonlyMap<string, Issue[]>,
  nowMs: number,
): {
  pin: ReadonlyMap<string, readonly InboxPinnedKey[]>;
  display: Map<string, Issue[]>;
} {
  const parentIssueIds = new Set([...pinned.keys(), ...fresh.keys()]);
  const nextPin = new Map<string, readonly InboxPinnedKey[]>();
  const display = new Map<string, Issue[]>();

  for (const parentIssueId of parentIssueIds) {
    const freshChildren = fresh.get(parentIssueId) ?? [];
    const freshChildById = new Map(freshChildren.map((child) => [child.id, child]));
    const reconciled = reconcileKeys(
      pinned.get(parentIssueId) ?? [],
      freshChildren.map((child) => child.id),
      nowMs,
    );

    if (reconciled.entries.length > 0) {
      nextPin.set(parentIssueId, reconciled.entries);
    }
    if (fresh.has(parentIssueId)) {
      display.set(
        parentIssueId,
        reconciled.visibleKeys.flatMap((key) => {
          const child = freshChildById.get(key);
          return child ? [child] : [];
        }),
      );
    }
  }

  return { pin: nextPin, display };
}

function reconcileSection(
  pinned: InboxPinnedSectionOrder | undefined,
  fresh: InboxGroupedSection,
  nowMs: number,
): { pin: InboxPinnedSectionOrder; display: InboxGroupedSection } {
  if (!pinned) {
    return { pin: captureSection(fresh), display: fresh };
  }

  const freshItemByKey = new Map(
    fresh.displayItems.map((item) => [inboxOrderRowKey(item), item]),
  );
  const rows = reconcileKeys(
    pinned.rows,
    fresh.displayItems.map(inboxOrderRowKey),
    nowMs,
  );
  const children = reconcileChildren(pinned.childrenByIssueId, fresh.childrenByIssueId, nowMs);

  return {
    pin: {
      key: fresh.key,
      missingSince: null,
      rows: rows.entries,
      childrenByIssueId: children.pin,
    },
    display: {
      ...fresh,
      displayItems: rows.visibleKeys.flatMap((key) => {
        const item = freshItemByKey.get(key);
        return item ? [item] : [];
      }),
      childrenByIssueId: children.display,
    },
  };
}

/**
 * Applies a previously committed Inbox order to freshly computed sections.
 *
 * `nowMs` is explicit so reconciliation remains pure. Callers should retain the
 * returned pin between reconciliations and replace it with `captureInboxOrderPin`
 * at an attention/refresh commit point.
 */
export function reconcileInboxOrderPin(
  pinned: InboxOrderPin,
  freshSections: readonly InboxGroupedSection[],
  nowMs: number,
): InboxOrderPinReconcileResult {
  const freshSectionByKey = new Map(freshSections.map((section) => [section.key, section]));
  const sections = reconcileKeys(
    pinned.sections,
    freshSections.map((section) => section.key),
    nowMs,
  );
  const pinnedSectionByKey = new Map(pinned.sections.map((section) => [section.key, section]));
  const reconciledByKey = new Map<string, ReturnType<typeof reconcileSection>>();

  for (const freshSection of freshSections) {
    reconciledByKey.set(
      freshSection.key,
      reconcileSection(
        sections.retainedPinnedKeys.has(freshSection.key)
          ? pinnedSectionByKey.get(freshSection.key)
          : undefined,
        freshSection,
        nowMs,
      ),
    );
  }

  const nextPinnedSections = sections.entries.flatMap((entry): InboxPinnedSectionOrder[] => {
    const reconciled = reconciledByKey.get(entry.key);
    if (reconciled) return [{ ...reconciled.pin, missingSince: entry.missingSince }];
    const previous = pinnedSectionByKey.get(entry.key);
    return previous ? [{ ...previous, missingSince: entry.missingSince }] : [];
  });

  return {
    sections: sections.visibleKeys.flatMap((key) => {
      const freshSection = freshSectionByKey.get(key);
      if (!freshSection) return [];
      return [reconciledByKey.get(key)?.display ?? freshSection];
    }),
    pin: { sections: nextPinnedSections },
  };
}
