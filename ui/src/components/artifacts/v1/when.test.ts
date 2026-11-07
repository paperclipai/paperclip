import { describe, expect, it } from "vitest";
import { countLabel, panelDateLabel, sizeLabel, updatedLabel } from "./when";

// Monday 2026-09-28, 6:00 PM local time.
const NOW = new Date("2026-09-28T18:00:00");

describe("updatedLabel", () => {
  it("gives the time today, Yesterday, the weekday within a week, then the date", () => {
    expect(updatedLabel("2026-09-28T16:05:00", NOW)).toBe("4:05 PM");
    expect(updatedLabel("2026-09-27T23:30:00", NOW)).toBe("Yesterday");
    expect(updatedLabel("2026-09-23T09:00:00", NOW)).toBe("Wednesday");
    expect(updatedLabel("2026-09-12T09:00:00", NOW)).toBe("Sep 12");
  });
});

describe("panelDateLabel", () => {
  it("gives Today, Yesterday, a day count within a week, then the long date", () => {
    expect(panelDateLabel("2026-09-28T08:00:00", NOW)).toBe("Today");
    expect(panelDateLabel("2026-09-27T08:00:00", NOW)).toBe("Yesterday");
    expect(panelDateLabel("2026-09-25T08:00:00", NOW)).toBe("3D ago");
    expect(panelDateLabel("2026-07-23T08:00:00", NOW)).toBe("July 23");
  });
});

describe("countLabel and sizeLabel", () => {
  it("pluralise and format", () => {
    expect(countLabel(1)).toBe("1 Artifact");
    expect(countLabel(21)).toBe("21 Artifacts");
    expect(sizeLabel(512)).toBe("512 B");
    expect(sizeLabel(59085)).toBe("57.7 KB");
    expect(sizeLabel(1289748)).toBe("1.2 MB");
    expect(sizeLabel(null)).toBeNull();
  });
});
