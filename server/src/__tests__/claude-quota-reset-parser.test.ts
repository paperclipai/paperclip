import { describe, expect, it } from "vitest";
import { parseClaudeQuotaResetTime } from "../services/claude-quota-reset.ts";

describe("parseClaudeQuotaResetTime", () => {
	it("returns null when error is empty or unrelated", () => {
		expect(parseClaudeQuotaResetTime(null)).toBeNull();
		expect(parseClaudeQuotaResetTime("")).toBeNull();
		expect(
			parseClaudeQuotaResetTime("Claude run failed: subtype=success"),
		).toBeNull();
		expect(
			parseClaudeQuotaResetTime("Process lost -- server may have restarted"),
		).toBeNull();
	});

	it("parses the canonical 10am Europe/Prague reset and returns next occurrence", () => {
		// Before 10:00 Prague today (which is 08:00 UTC in May, DST=CEST=UTC+2)
		const now = new Date("2026-05-12T05:00:00.000Z");
		const reset = parseClaudeQuotaResetTime(
			"Claude run failed: subtype=success: You're out of extra usage · resets 10am (Europe/Prague)",
			now,
		);
		expect(reset).not.toBeNull();
		expect(reset!.toISOString()).toBe("2026-05-12T08:00:00.000Z");
	});

	it("advances to next day when reset time is already past", () => {
		// 11:00 UTC = 13:00 Prague CEST, so today's 10am Prague (08:00 UTC) already passed
		const now = new Date("2026-05-12T11:00:00.000Z");
		const reset = parseClaudeQuotaResetTime(
			"out of extra usage · resets 10am (Europe/Prague)",
			now,
		);
		expect(reset).not.toBeNull();
		expect(reset!.toISOString()).toBe("2026-05-13T08:00:00.000Z");
	});

	it("handles 12am as midnight and 12pm as noon", () => {
		const now = new Date("2026-05-12T20:00:00.000Z"); // 22:00 Prague
		const midnight = parseClaudeQuotaResetTime(
			"out of extra usage · resets 12am (Europe/Prague)",
			now,
		);
		expect(midnight).not.toBeNull();
		// Next midnight Prague (00:00) = 22:00 UTC the same day
		expect(midnight!.toISOString()).toBe("2026-05-12T22:00:00.000Z");

		const noon = parseClaudeQuotaResetTime(
			"out of extra usage · resets 12pm (Europe/Prague)",
			now,
		);
		expect(noon).not.toBeNull();
		// 12:00 Prague today already past, so tomorrow's noon = 10:00 UTC
		expect(noon!.toISOString()).toBe("2026-05-13T10:00:00.000Z");
	});

	it("parses pm hours correctly", () => {
		const now = new Date("2026-05-12T05:00:00.000Z"); // 07:00 Prague
		const reset = parseClaudeQuotaResetTime(
			"out of extra usage · resets 11pm (Europe/Prague)",
			now,
		);
		expect(reset).not.toBeNull();
		// 23:00 Prague today = 21:00 UTC same day
		expect(reset!.toISOString()).toBe("2026-05-12T21:00:00.000Z");
	});

	it("parses minutes when present", () => {
		const now = new Date("2026-05-12T05:00:00.000Z"); // 07:00 Prague
		const reset = parseClaudeQuotaResetTime(
			"out of extra usage · resets 10:30am (Europe/Prague)",
			now,
		);
		expect(reset).not.toBeNull();
		expect(reset!.toISOString()).toBe("2026-05-12T08:30:00.000Z");
	});

	it("supports other IANA timezones (America/Los_Angeles)", () => {
		// 2026-05-12T05:00:00Z is 22:00 PDT (UTC-7) the previous calendar day
		const now = new Date("2026-05-12T05:00:00.000Z");
		const reset = parseClaudeQuotaResetTime(
			"out of extra usage · resets 9am (America/Los_Angeles)",
			now,
		);
		expect(reset).not.toBeNull();
		// 09:00 PDT 2026-05-12 = 16:00 UTC (PDT = UTC-7)
		expect(reset!.toISOString()).toBe("2026-05-12T16:00:00.000Z");
	});

	it("returns null for unknown timezone or malformed", () => {
		const now = new Date("2026-05-12T05:00:00.000Z");
		expect(
			parseClaudeQuotaResetTime(
				"out of extra usage · resets 10am (Not/A_Real_TZ)",
				now,
			),
		).toBeNull();
		expect(
			parseClaudeQuotaResetTime(
				"out of extra usage · resets 99am (Europe/Prague)",
				now,
			),
		).toBeNull();
	});
});
