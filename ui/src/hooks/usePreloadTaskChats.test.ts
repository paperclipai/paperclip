import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { inboxNavEntryTask, type InboxKeyboardNavEntry, type InboxWorkItem } from "@/lib/inbox";
import { topRenderedNavEntryRefs, topTaskRefs } from "./usePreloadTaskChats";

type Entry = Parameters<typeof topRenderedNavEntryRefs>[0][number];

const row = (index: number, budgetOrdinal = index + 1): Entry =>
  ({ type: "issue", issue: { id: `id-${index}`, identifier: `T-${index}` }, budgetOrdinal });

describe("topTaskRefs over a large grouped and nested Inbox", () => {
  // 3,000 entries: a group header every 50 rows, non-task rows (approvals,
  // runs) between tasks, and nested child tasks under their parents.
  function inboxEntries(): InboxKeyboardNavEntry[] {
    const entries: InboxKeyboardNavEntry[] = [];
    for (let index = 0; entries.length < 3_000; index += 1) {
      if (index % 50 === 0) entries.push({ type: "group", groupKey: `g-${index}`, label: `Group ${index}`, collapsed: false });
      if (index % 3 === 0) {
        entries.push({ type: "top", itemKey: `approval-${index}`, item: { kind: "approval" } as unknown as InboxWorkItem });
        continue;
      }
      const issue = { id: `id-${index}`, identifier: `T-${index}` } as Issue;
      entries.push({ type: "top", itemKey: `issue-${index}`, item: { kind: "issue", issue } as unknown as InboxWorkItem });
      entries.push({ type: "child", issueId: `child-${index}`, issue: { id: `child-${index}`, identifier: null } as unknown as Issue });
    }
    return entries;
  }

  it("takes the first ten tasks in display order, parents and children alike", () => {
    expect(topTaskRefs(inboxEntries(), inboxNavEntryTask)).toEqual([
      "T-1", "child-1", "T-2", "child-2", "T-4", "child-4", "T-5", "child-5", "T-7", "child-7",
    ]);
  });

  it("stops reading entries once it has ten tasks", () => {
    let reads = 0;
    const counted = function* () {
      for (const entry of inboxEntries()) {
        reads += 1;
        if (reads > 20) throw new Error("read past the preload limit");
        yield entry;
      }
    };
    expect(topTaskRefs(counted(), inboxNavEntryTask)).toHaveLength(10);
    // A header, ten tasks and the non-task rows between them.
    expect(reads).toBe(14);
  });
});

describe("topRenderedNavEntryRefs", () => {
  it("takes the first ten rendered rows in display order and skips group headers", () => {
    const entries: Entry[] = [{ type: "group" }, row(0), row(1), { type: "group" }, ...Array.from({ length: 20 }, (_, index) => row(index + 2))];
    expect(topRenderedNavEntryRefs(entries, 100)).toEqual(Array.from({ length: 10 }, (_, index) => `T-${index}`));
  });

  it("skips rows past the render budget", () => {
    // Rows of a collapsed group consume budget but have no entries; later rows can fall past it.
    const entries: Entry[] = [row(0, 1), row(1, 2), row(2, 150), row(3, 151)];
    expect(topRenderedNavEntryRefs(entries, 100)).toEqual(["T-0", "T-1"]);
  });

  it("stops reading at the limit in a list of thousands of rows", () => {
    let reads = 0;
    const entries = new Proxy(Array.from({ length: 5_000 }, (_, index) => row(index)), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads += 1;
          if (reads > 10) throw new Error("read past the preload limit");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(topRenderedNavEntryRefs(entries, 10_000)).toHaveLength(10);
    expect(reads).toBe(10);
  });
});
