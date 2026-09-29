import type { HeartbeatRunLogPage } from "@paperclipai/shared";

type Page = Pick<HeartbeatRunLogPage, "content" | "nextOffset" | "cursor" | "hasMore">;
export function nextRunLogPosition(previous: number | string, page: Page): number | string {
  if (page.cursor !== undefined) return page.cursor;
  if (page.nextOffset !== undefined) return page.nextOffset;
  const length = new TextEncoder().encode(page.content).length;
  return typeof previous === "string" ? String(BigInt(previous) + BigInt(length)) : previous + length;
}
export function runLogHasMore(page: Page): boolean {
  return page.hasMore ?? page.nextOffset !== undefined;
}
