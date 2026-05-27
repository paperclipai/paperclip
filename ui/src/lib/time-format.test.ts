import { afterEach, describe, expect, it, vi } from "vitest";

import { timeAgo } from "./timeAgo";
import { formatDurationMs, relativeTime } from "./utils";

describe("runtime time formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps English as the default relative time language", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));

    expect(timeAgo("2026-04-24T11:58:00.000Z")).toBe("2m ago");
    expect(relativeTime("2026-04-24T10:00:00.000Z")).toBe("2h ago");
  });

  it("formats relative time and compact durations in Korean when requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));

    expect(timeAgo("2026-04-24T11:58:00.000Z", "ko")).toBe("2분 전");
    expect(relativeTime("2026-04-24T10:00:00.000Z", "ko-KR")).toBe("2시간 전");
    expect(formatDurationMs(65_000, "ko")).toBe("1분 5초");
  });
});
