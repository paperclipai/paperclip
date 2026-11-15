import { describe, expect, it } from "vitest";
import {
  avatarPair,
  feedIsCompact,
  filterChats,
  formatClock,
  formatDayLabel,
  formatListTime,
  groupThread,
  keepShownPhoto,
  shellIsNarrow,
  unreadLabel,
  type InboxMessage,
} from "../src/ui/inbox-model.js";

const now = new Date(2026, 10, 15, 12, 0, 0);

function at(day: number, hours: number, minutes: number, year = 2026, month = 10): string {
  return new Date(year, month, day, hours, minutes, 0).toISOString();
}

describe("telegram inbox model", () => {
  it("keeps a shown list avatar when the next payload is empty", () => {
    const shown = "data:image/jpeg;base64,abc";
    expect(keepShownPhoto(shown, null)).toBe(shown);
    expect(keepShownPhoto(shown, undefined)).toBe(shown);
    expect(keepShownPhoto(null, shown)).toBe(shown);
    expect(keepShownPhoto(null, null)).toBeNull();
    expect(keepShownPhoto(null, "not-a-photo")).toBeNull();
  });

  it("keeps the avatar color stable for a chat id", () => {
    const first = avatarPair("issue-1");
    expect(avatarPair("issue-1")).toEqual(first);
    expect(avatarPair("issue-1")).not.toEqual(avatarPair("issue-2"));
  });

  it("treats 925px as a single column and 926px as two", () => {
    expect(shellIsNarrow(925)).toBe(true);
    expect(shellIsNarrow(926)).toBe(false);
    expect(shellIsNarrow(0)).toBe(false);
    expect(feedIsCompact(600)).toBe(true);
    expect(feedIsCompact(601)).toBe(false);
  });

  it("labels calendar days in Russian and English", () => {
    expect(formatDayLabel(new Date(2026, 10, 15, 9, 0), now, true)).toBe("Сегодня");
    expect(formatDayLabel(new Date(2026, 10, 14, 9, 0), now, true)).toBe("Вчера");
    expect(formatDayLabel(new Date(2026, 10, 2, 9, 0), now, true)).toBe("2 ноября");
    expect(formatDayLabel(new Date(2025, 10, 15, 9, 0), now, true)).toBe("15 ноября 2025");
    expect(formatDayLabel(new Date(2026, 10, 15, 9, 0), now, false)).toBe("Today");
    expect(formatDayLabel(new Date(2026, 10, 14, 9, 0), now, false)).toBe("Yesterday");
    expect(formatDayLabel(new Date(2026, 10, 2, 9, 0), now, false)).toBe("November 2");
    expect(formatDayLabel(new Date(2025, 10, 15, 9, 0), now, false)).toBe("November 15 2025");
  });

  it("shows a clock for today's list row and a date afterwards", () => {
    expect(formatListTime(at(15, 9, 5), now, true)).toBe(formatClock(new Date(2026, 10, 15, 9, 5)));
    expect(formatListTime(at(14, 9, 5), now, true)).toBe("Вчера");
    expect(formatListTime("", now, true)).toBe("");
  });

  it("hides a zero unread count and caps the badge at 99+", () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(null)).toBeNull();
    expect(unreadLabel(4)).toBe("4");
    expect(unreadLabel(100)).toBe("99+");
  });

  it("filters the loaded list by name and preview without dropping other rows' order", () => {
    const rows = [
      { label: "Анна", preview: "счёт" },
      { label: "Борис", preview: "доставка" },
    ];
    expect(filterChats(rows, "  доставка ")).toEqual([rows[1]]);
    expect(filterChats(rows, "ан")).toEqual([rows[0]]);
    expect(filterChats(rows, "")).toEqual(rows);
  });

  it("groups one side until the day or the speaker changes", () => {
    const messages: InboxMessage[] = [
      { id: "1", direction: "in", text: "a", at: at(15, 9, 0) },
      { id: "2", direction: "in", text: "b", at: at(15, 9, 1) },
      { id: "3", direction: "out", text: "c", at: at(15, 9, 2) },
      { id: "4", direction: "out", text: "d", at: at(14, 18, 0) },
    ];
    const days = groupThread(messages, now, true);
    expect(days.map((day) => day.label)).toEqual(["Сегодня", "Вчера"]);
    expect(days[0]?.groups).toHaveLength(2);
    expect(days[0]?.groups[0]?.messages.map((message) => message.position)).toEqual(["first", "last"]);
    expect(days[0]?.groups[1]?.messages.map((message) => message.position)).toEqual(["single"]);
    expect(days[1]?.groups[0]?.direction).toBe("out");
  });
});
