/**
 * Heartbeat active-window policy.
 *
 * Adds an optional `activeWindow` field to the heartbeat policy so the
 * scheduler only fires timer wakeups during configured local hours and
 * days. Omitted/absent = always-on (current behavior).
 *
 * Shape:
 *
 *   {
 *     timezone:   string,        // IANA tz, e.g. "Africa/Johannesburg"
 *     daysOfWeek: number[],      // 0=Sun..6=Sat, deduped + sorted on parse
 *     startMinute: number,       // 0..1439, minutes from local midnight
 *     endMinute:   number        // 0..1439, exclusive; if < start → window crosses midnight
 *   }
 *
 * Single contiguous window per day. Cross-midnight is expressed by setting
 * endMinute < startMinute (e.g. 22:00..02:00 = startMinute 1320, endMinute 120).
 *
 * Equal start/end means a degenerate window (always-out); rejected on parse.
 *
 * No persistence migration is needed — `runtimeConfig` is a JSONB blob and
 * absent `activeWindow` is treated as "no window".
 */

import { unprocessable } from "../errors.js";

export const DEFAULT_HEARTBEAT_TIMEZONE = "Africa/Johannesburg";

export const MINUTES_PER_DAY = 24 * 60;

export interface HeartbeatActiveWindow {
	timezone: string;
	daysOfWeek: number[];
	startMinute: number;
	endMinute: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

function assertTimeZone(timezone: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
	} catch {
		throw unprocessable(`Invalid timezone: ${timezone}`);
	}
}

function assertMinute(value: number, field: string): void {
	if (!Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) {
		throw unprocessable(
			`heartbeat.activeWindow.${field} must be an integer in [0, ${MINUTES_PER_DAY})`,
		);
	}
}

function assertDaysOfWeek(days: number[]): void {
	if (days.length === 0) {
		throw unprocessable("heartbeat.activeWindow.daysOfWeek must have at least one day");
	}
	for (const day of days) {
		if (!Number.isInteger(day) || day < 0 || day > 6) {
			throw unprocessable(
				"heartbeat.activeWindow.daysOfWeek entries must be integers 0..6 (Sun=0..Sat=6)",
			);
		}
	}
}

/**
 * Validate an already-shaped active window. Throws `unprocessable` on
 * invalid timezone, out-of-range minutes, empty/invalid day set, or a
 * degenerate equal-start-end window.
 */
export function assertActiveWindow(window: HeartbeatActiveWindow): void {
	if (typeof window.timezone !== "string" || window.timezone.length === 0) {
		throw unprocessable("heartbeat.activeWindow.timezone must be a non-empty IANA timezone string");
	}
	assertTimeZone(window.timezone);
	assertMinute(window.startMinute, "startMinute");
	assertMinute(window.endMinute, "endMinute");
	if (window.startMinute === window.endMinute) {
		throw unprocessable(
			"heartbeat.activeWindow.startMinute and endMinute must differ (degenerate window)",
		);
	}
	assertDaysOfWeek(window.daysOfWeek);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an unknown value into a HeartbeatActiveWindow.
 *
 * - `undefined` / `null` → `null` (means "no window configured").
 * - Anything not shaped like a window object → throws `unprocessable`. We
 *   choose strict over silent because a malformed window would otherwise
 *   degrade to always-on, masking misconfiguration.
 * - Days are deduped and sorted.
 */
export function parseActiveWindow(input: unknown): HeartbeatActiveWindow | null {
	if (input == null) return null;
	if (!isPlainObject(input)) {
		throw unprocessable("heartbeat.activeWindow must be an object or null");
	}

	const { timezone, daysOfWeek, startMinute, endMinute } = input;
	if (
		typeof timezone !== "string" ||
		!Array.isArray(daysOfWeek) ||
		typeof startMinute !== "number" ||
		typeof endMinute !== "number"
	) {
		throw unprocessable(
			"heartbeat.activeWindow requires { timezone, daysOfWeek[], startMinute, endMinute }",
		);
	}

	const dedupedDays = Array.from(new Set(daysOfWeek.map((d) => Math.trunc(Number(d))))).sort(
		(a, b) => a - b,
	);

	const window: HeartbeatActiveWindow = {
		timezone,
		daysOfWeek: dedupedDays,
		startMinute: Math.trunc(startMinute),
		endMinute: Math.trunc(endMinute),
	};
	assertActiveWindow(window);
	return window;
}

interface ZonedMoment {
	minuteOfDay: number;
	weekday: number;
}

function zonedNow(now: Date, timezone: string): ZonedMoment {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hour12: false,
		hour: "numeric",
		minute: "numeric",
		weekday: "short",
	});
	const parts = formatter.formatToParts(now);
	const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
	const hour = Number(map.hour);
	const minute = Number(map.minute);
	const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
	if (!Number.isFinite(hour) || !Number.isFinite(minute) || weekday == null) {
		throw new Error(`Unable to resolve zoned time for timezone ${timezone}`);
	}
	// Intl returns "24" for midnight in some locales; normalize to 0.
	const normalizedHour = hour === 24 ? 0 : hour;
	return { minuteOfDay: normalizedHour * 60 + minute, weekday };
}

/**
 * Return true if `now` falls inside the active window in the window's
 * configured timezone, on one of the configured days.
 *
 * Cross-midnight windows (endMinute < startMinute) are treated as a single
 * span beginning on each configured day. The day check uses the local day
 * at `startMinute` (the "owning" day) — i.e. a window of Mon 22:00..02:00
 * is active Mon 22:00..23:59 AND Tue 00:00..02:00 only if Mon is in the
 * day set.
 */
export function isWithinActiveWindow(window: HeartbeatActiveWindow, now: Date): boolean {
	const { startMinute, endMinute, daysOfWeek, timezone } = window;
	const { minuteOfDay, weekday } = zonedNow(now, timezone);

	if (startMinute < endMinute) {
		if (!daysOfWeek.includes(weekday)) return false;
		return minuteOfDay >= startMinute && minuteOfDay < endMinute;
	}

	// Cross-midnight: active either after start on the owning day, or
	// before end on the day after an owning day.
	if (minuteOfDay >= startMinute && daysOfWeek.includes(weekday)) {
		return true;
	}
	if (minuteOfDay < endMinute) {
		const previousDay = (weekday + 6) % 7;
		return daysOfWeek.includes(previousDay);
	}
	return false;
}
