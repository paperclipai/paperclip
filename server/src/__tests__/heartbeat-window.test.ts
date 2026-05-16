import { describe, expect, it } from "vitest";
import {
	DEFAULT_HEARTBEAT_TIMEZONE,
	MINUTES_PER_DAY,
	assertActiveWindow,
	isWithinActiveWindow,
	parseActiveWindow,
	type HeartbeatActiveWindow,
} from "../services/heartbeat-window.js";

const SAST = "Africa/Johannesburg";
const UTC = "UTC";

// A Date constructed from a UTC ISO string lets us reason about both UTC and
// SAST (UTC+2 no DST) wall-clock times without relying on process TZ.
function utc(iso: string): Date {
	return new Date(iso);
}

describe("DEFAULT_HEARTBEAT_TIMEZONE", () => {
	it("defaults to Africa/Johannesburg", () => {
		expect(DEFAULT_HEARTBEAT_TIMEZONE).toBe("Africa/Johannesburg");
	});
});

describe("parseActiveWindow", () => {
	const ok = {
		timezone: SAST,
		daysOfWeek: [1, 2, 3, 4, 5],
		startMinute: 9 * 60,
		endMinute: 17 * 60,
	};

	it("returns null for undefined/null", () => {
		expect(parseActiveWindow(undefined)).toBeNull();
		expect(parseActiveWindow(null)).toBeNull();
	});

	it("parses a well-formed window", () => {
		expect(parseActiveWindow(ok)).toEqual(ok);
	});

	it("dedupes and sorts daysOfWeek", () => {
		const parsed = parseActiveWindow({ ...ok, daysOfWeek: [5, 1, 3, 5, 1] });
		expect(parsed?.daysOfWeek).toEqual([1, 3, 5]);
	});

	it("truncates non-integer minutes", () => {
		const parsed = parseActiveWindow({ ...ok, startMinute: 9.7 * 60, endMinute: 17.9 * 60 });
		expect(parsed).toEqual({ ...ok, startMinute: Math.trunc(9.7 * 60), endMinute: Math.trunc(17.9 * 60) });
	});

	it.each([
		["non-object input", "not-a-window"],
		["array input", [1, 2, 3]],
	])("rejects %s", (_label, input) => {
		expect(() => parseActiveWindow(input)).toThrow();
	});

	it.each([
		["missing timezone", { ...ok, timezone: undefined }],
		["missing daysOfWeek", { ...ok, daysOfWeek: undefined }],
		["missing startMinute", { ...ok, startMinute: undefined }],
		["missing endMinute", { ...ok, endMinute: undefined }],
	])("rejects partial shape (%s)", (_label, input) => {
		expect(() => parseActiveWindow(input)).toThrow();
	});

	it("rejects an invalid IANA timezone", () => {
		expect(() => parseActiveWindow({ ...ok, timezone: "Mars/Olympus" })).toThrow();
	});

	it("rejects out-of-range minutes", () => {
		expect(() => parseActiveWindow({ ...ok, startMinute: -1 })).toThrow();
		expect(() => parseActiveWindow({ ...ok, endMinute: MINUTES_PER_DAY })).toThrow();
	});

	it("rejects a degenerate window where start === end", () => {
		expect(() => parseActiveWindow({ ...ok, startMinute: 540, endMinute: 540 })).toThrow();
	});

	it("rejects an empty daysOfWeek array", () => {
		expect(() => parseActiveWindow({ ...ok, daysOfWeek: [] })).toThrow();
	});

	it("rejects out-of-range days", () => {
		expect(() => parseActiveWindow({ ...ok, daysOfWeek: [7] })).toThrow();
		expect(() => parseActiveWindow({ ...ok, daysOfWeek: [-1] })).toThrow();
	});
});

describe("assertActiveWindow", () => {
	it("accepts a valid window", () => {
		const window: HeartbeatActiveWindow = {
			timezone: UTC,
			daysOfWeek: [0, 6],
			startMinute: 0,
			endMinute: 60,
		};
		expect(() => assertActiveWindow(window)).not.toThrow();
	});
});

describe("isWithinActiveWindow — same-day window (09:00..17:00 SAST, Mon..Fri)", () => {
	const window: HeartbeatActiveWindow = {
		timezone: SAST,
		daysOfWeek: [1, 2, 3, 4, 5],
		startMinute: 9 * 60,
		endMinute: 17 * 60,
	};

	// 2026-05-18 is a Monday. SAST = UTC+2 (no DST in Johannesburg).
	it("is true at exactly start (Mon 09:00 SAST = Mon 07:00 UTC)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-18T07:00:00Z"))).toBe(true);
	});

	it("is true mid-window (Mon 12:00 SAST)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-18T10:00:00Z"))).toBe(true);
	});

	it("is false at exactly end (Mon 17:00 SAST is exclusive)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-18T15:00:00Z"))).toBe(false);
	});

	it("is false before start (Mon 08:59 SAST)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-18T06:59:00Z"))).toBe(false);
	});

	it("is false after end (Mon 17:01 SAST)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-18T15:01:00Z"))).toBe(false);
	});

	it("is false on Saturday inside the time band (2026-05-16 Sat 12:00 SAST)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-16T10:00:00Z"))).toBe(false);
	});

	it("is false on Sunday (2026-05-17 Sun 12:00 SAST)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-17T10:00:00Z"))).toBe(false);
	});
});

describe("isWithinActiveWindow — cross-midnight window (22:00..02:00 UTC, Fri only)", () => {
	const window: HeartbeatActiveWindow = {
		timezone: UTC,
		daysOfWeek: [5], // Fri owns the window
		startMinute: 22 * 60,
		endMinute: 2 * 60,
	};

	it("is true late Fri (Fri 22:30 UTC)", () => {
		// 2026-05-22 is Friday.
		expect(isWithinActiveWindow(window, utc("2026-05-22T22:30:00Z"))).toBe(true);
	});

	it("is true early Sat carrying over from Fri (Sat 01:30 UTC)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-23T01:30:00Z"))).toBe(true);
	});

	it("is false at Sat 02:00 (exclusive)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-23T02:00:00Z"))).toBe(false);
	});

	it("is false Sat 22:30 (Sat is not an owning day)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-23T22:30:00Z"))).toBe(false);
	});

	it("is false Fri 21:59 (before start)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-22T21:59:00Z"))).toBe(false);
	});

	it("is false Sun 01:00 (Sat→Sun carry-over: Sat is not owning)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-24T01:00:00Z"))).toBe(false);
	});
});

describe("isWithinActiveWindow — timezone correctness", () => {
	// Window: 09:00..17:00 in Asia/Tokyo (UTC+9), every day.
	const window: HeartbeatActiveWindow = {
		timezone: "Asia/Tokyo",
		daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
		startMinute: 9 * 60,
		endMinute: 17 * 60,
	};

	it("is true at Tokyo 09:00 = 00:00 UTC", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-18T00:00:00Z"))).toBe(true);
	});

	it("is false at 23:59 UTC (08:59 next-day Tokyo, before start)", () => {
		expect(isWithinActiveWindow(window, utc("2026-05-18T23:59:00Z"))).toBe(false);
	});
});
