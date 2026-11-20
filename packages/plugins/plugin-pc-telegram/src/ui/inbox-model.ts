import { compareTelegramMessageOrder } from "../history-slice.js";

export const AVATAR_PAIRS = [
  ["var(--chart-1)", "var(--primary)"],
  ["var(--chart-2)", "var(--chart-1)"],
  ["var(--chart-3)", "var(--accent)"],
  ["var(--chart-4)", "var(--chart-2)"],
  ["var(--chart-5)", "var(--primary)"],
  ["var(--accent)", "var(--chart-3)"],
  ["var(--primary)", "var(--chart-4)"],
] as const;

const MONTHS_RU = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type BubblePosition = "single" | "first" | "middle" | "last";

export type InboxForward = {
  kind?: string | null;
  name?: string | null;
  author?: string | null;
};

export type InboxMessage = {
  id: string;
  direction: "in" | "out";
  text: string;
  at: string;
  forward?: InboxForward | null;
  placeholder?: boolean;
};

export type InboxGroup = {
  key: string;
  direction: "in" | "out";
  messages: Array<InboxMessage & { position: BubblePosition }>;
};

export type InboxDay = {
  key: string;
  bucket: string;
  label: string | null;
  groups: InboxGroup[];
};

export function shellIsNarrow(width: number): boolean {
  return width > 0 && width <= 925;
}

export function feedIsCompact(width: number): boolean {
  return width > 0 && width <= 600;
}

export function keepShownPhoto(shown: string | null | undefined, incoming: string | null | undefined): string | null {
  const next = usableListPhoto(incoming);
  if (next) return next;
  return usableListPhoto(shown);
}

function usableListPhoto(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("data:image/") || value.length > 480_000) return null;
  if (/[\s"'()]/.test(value)) return null;
  return value;
}

export function avatarPair(id: string): (typeof AVATAR_PAIRS)[number] {
  let hash = 5381;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash * 33) ^ id.charCodeAt(index)) >>> 0;
  }
  return AVATAR_PAIRS[hash % AVATAR_PAIRS.length] ?? AVATAR_PAIRS[0];
}

export function initialLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return Array.from(trimmed)[0]?.toLocaleUpperCase() ?? "";
}

export function parseTime(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function formatDayLabel(date: Date, now: Date, ru: boolean): string {
  if (sameDay(date, now)) return ru ? "Сегодня" : "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return ru ? "Вчера" : "Yesterday";
  const month = (ru ? MONTHS_RU : MONTHS_EN)[date.getMonth()] ?? "";
  const body = ru ? `${date.getDate()} ${month}` : `${month} ${date.getDate()}`;
  if (date.getFullYear() !== now.getFullYear()) return `${body} ${date.getFullYear()}`;
  return body;
}

export function formatLastSeen(date: Date, ru: boolean, now = new Date()): string {
  const clock = formatClock(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (ru) {
    if (sameDay(date, now)) return `был(а) сегодня в ${clock}`;
    if (sameDay(date, yesterday)) return `был(а) вчера в ${clock}`;
    const month = MONTHS_RU[date.getMonth()] ?? "";
    const body = `${date.getDate()} ${month}`;
    const dated = date.getFullYear() === now.getFullYear() ? body : `${body} ${date.getFullYear()}`;
    return `был(а) ${dated} в ${clock}`;
  }
  if (sameDay(date, now)) return `last seen today at ${clock}`;
  if (sameDay(date, yesterday)) return `last seen yesterday at ${clock}`;
  return `last seen ${formatDayLabel(date, now, false)} at ${clock}`;
}

export function formatListTime(value: string, now: Date, ru: boolean): string {
  const date = parseTime(value);
  if (!date) return "";
  if (sameDay(date, now)) return formatClock(date);
  return formatDayLabel(date, now, ru);
}

export function unreadLabel(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const whole = Math.floor(value);
  return whole > 99 ? "99+" : String(whole);
}

export function bubblePosition(index: number, count: number): BubblePosition {
  if (count <= 1) return "single";
  if (index <= 0) return "first";
  if (index >= count - 1) return "last";
  return "middle";
}

function dayKey(date: Date | null): string {
  if (!date) return "undated";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function groupThread(messages: InboxMessage[], now: Date, ru: boolean): InboxDay[] {
  const days: InboxDay[] = [];
  for (const message of messages) {
    const date = parseTime(message.at);
    const bucket = dayKey(date);
    let day = days[days.length - 1];
    if (!day || day.bucket !== bucket) {
      day = {
        key: bucket,
        bucket,
        label: date ? formatDayLabel(date, now, ru) : null,
        groups: [],
      };
      days.push(day);
    }
    const group = day.groups[day.groups.length - 1];
    if (!group || group.direction !== message.direction) {
      day.groups.push({
        key: `${bucket}:${message.id}`,
        direction: message.direction,
        messages: [{ ...message, position: "single" }],
      });
      continue;
    }
    group.messages.push({ ...message, position: "single" });
  }
  for (const day of days) {
    for (const group of day.groups) {
      const count = group.messages.length;
      group.messages.forEach((message, index) => {
        message.position = bubblePosition(index, count);
      });
    }
  }
  return days;
}

export function mergeThreadMessages<T extends { id: string; at: string }>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, T>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareTelegramMessageOrder);
}

export function oldestNumericId(messages: Array<{ id: string }>): string | null {
  let oldest: number | null = null;
  for (const message of messages) {
    if (!/^\d{1,16}$/.test(message.id)) continue;
    const value = Number(message.id);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (oldest == null || value < oldest) oldest = value;
  }
  return oldest == null ? null : String(oldest);
}

export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number, slack = 96): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

export function issueRefFromPath(prefix: string, pathname: string): string {
  if (!prefix || !pathname) return "";
  const marker = `/${prefix}/telegram-inbox/`;
  const at = pathname.indexOf(marker);
  if (at < 0) return "";
  const ref = pathname.slice(at + marker.length).split("/").filter(Boolean)[0] ?? "";
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

export function sameThreadTop(
  current: Array<{ id: string; text?: string }>,
  incoming: Array<{ id: string; text?: string }>,
): boolean {
  if (current.length === 0 || incoming.length === 0) return false;
  const lastCurrent = current[current.length - 1];
  const lastIncoming = incoming[incoming.length - 1];
  if (!lastCurrent || !lastIncoming || lastCurrent.id !== lastIncoming.id) return false;
  if (
    lastCurrent.text !== undefined
    && lastIncoming.text !== undefined
    && lastCurrent.text !== lastIncoming.text
  ) return false;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (!previous || message.text === undefined || previous.text === undefined) continue;
    if (previous.text !== message.text) return false;
  }
  return true;
}

export type FeedRange = { start: number; end: number };

export const FEED_WINDOW = 40;

/** A loaded slice taller than one page draws a tail window. Shorter slices stay whole. */
export function tailFeedRange(count: number, size = FEED_WINDOW): FeedRange | null {
  if (count <= size) return null;
  return { start: count - size, end: count };
}

export function slideFeedRange(
  count: number,
  anchorIndex: number,
  current: FeedRange | null,
  overscan = 8,
  ahead = 24,
): FeedRange | null {
  if (count <= FEED_WINDOW || anchorIndex < 0) return null;
  const start = Math.max(0, anchorIndex - overscan);
  const end = Math.min(count, Math.max(anchorIndex + ahead, start + 16));
  if (
    current
    && anchorIndex >= current.start + 4
    && anchorIndex <= current.end - 8
    && start >= current.start
    && end <= current.end
  ) {
    return current;
  }
  return { start, end };
}

export function shiftFeedRange(range: FeedRange | null, added: number): FeedRange | null {
  if (!range || added <= 0) return range;
  if (range.start === 0) return { start: 0, end: range.end + added };
  return { start: range.start + added, end: range.end + added };
}

export function rememberCacheKey(order: string[], key: string, limit: number): string | null {
  const index = order.indexOf(key);
  if (index >= 0) order.splice(index, 1);
  order.push(key);
  if (order.length <= limit) return null;
  const evicted = order.shift() ?? null;
  if (evicted === key) {
    order.push(key);
    return null;
  }
  return evicted;
}

export function filterChats<T extends { label: string; preview?: string | null }>(rows: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    const preview = row.preview ?? "";
    return row.label.toLowerCase().includes(needle) || preview.toLowerCase().includes(needle);
  });
}
