import { formatRelativeTime } from "./locale";

export function timeAgo(date: Date | string): string {
  return formatRelativeTime(date);
}
