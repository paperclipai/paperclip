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
	const hour12 = Number(match[1]);
	const minute = match[2] ? Number(match[2]) : 0;
	const meridiem = match[3]?.toLowerCase();
	const timeZone = match[4]?.trim();
	if (!timeZone) return null;
	if (!Number.isFinite(hour12) || hour12 < 0 || hour12 > 23) return null;
	if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

	let hour24 = hour12;
	if (meridiem === "pm" && hour12 < 12) hour24 = hour12 + 12;
	else if (meridiem === "am" && hour12 === 12) hour24 = 0;
	else if (!meridiem && hour12 > 23) return null;

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
