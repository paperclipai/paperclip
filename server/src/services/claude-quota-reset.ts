// Parses Claude Max quota-exhaustion error messages of the form:
//   "Claude run failed: subtype=success: You're out of extra usage · resets 10am (Europe/Prague)"
// into a concrete UTC Date representing when the quota next replenishes.
//
// Kept as a pure utility (no db, no other services) so the heartbeat retry
// scheduler can unit-test the parsing logic in isolation.

const CLAUDE_QUOTA_RESET_PATTERN =
	/out of extra usage[\s\S]*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i;

function getTimeZoneOffsetMs(date: Date, timeZone: string): number | null {
	try {
		const fmt = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		const parts = Object.fromEntries(
			fmt.formatToParts(date).map((p) => [p.type, p.value]),
		);
		const hourRaw = parts.hour === "24" ? "0" : parts.hour;
		const utcInTz = Date.UTC(
			Number(parts.year),
			Number(parts.month) - 1,
			Number(parts.day),
			Number(hourRaw),
			Number(parts.minute),
			Number(parts.second),
		);
		return utcInTz - date.getTime();
	} catch {
		return null;
	}
}

export function parseClaudeQuotaResetTime(
	errorMessage: string | null | undefined,
	now: Date = new Date(),
): Date | null {
	if (!errorMessage) return null;
	const match = errorMessage.match(CLAUDE_QUOTA_RESET_PATTERN);
	if (!match) return null;
	const hourRaw = Number(match[1]);
	const minute = match[2] ? Number(match[2]) : 0;
	const meridiem = match[3]?.toLowerCase();
	const timeZone = match[4]?.trim();
	if (!timeZone) return null;
	if (!Number.isFinite(hourRaw) || hourRaw < 0) return null;
	if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

	// 12-hour clock must use 1..12; 24-hour clock (no am/pm) must use 0..23.
	// This rejects nonsense like "13pm" or "0am" instead of silently dropping
	// the meridiem and scheduling the retry at the wrong wall-clock time.
	let hour24: number;
	if (meridiem) {
		if (hourRaw < 1 || hourRaw > 12) return null;
		if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
		else hour24 = hourRaw === 12 ? 0 : hourRaw;
	} else {
		if (hourRaw > 23) return null;
		hour24 = hourRaw;
	}

	let parts: Record<string, string>;
	try {
		const todayFmt = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		parts = Object.fromEntries(
			todayFmt.formatToParts(now).map((p) => [p.type, p.value]),
		);
	} catch {
		return null;
	}
	const naiveUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		hour24,
		minute,
		0,
	);
	const offset = getTimeZoneOffsetMs(new Date(naiveUtc), timeZone);
	if (offset === null) return null;
	let target = naiveUtc - offset;
	if (target <= now.getTime()) {
		target += 24 * 60 * 60 * 1000;
	}
	return new Date(target);
}
