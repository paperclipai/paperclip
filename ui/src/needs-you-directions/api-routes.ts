import { registerApiRoute } from "./api-stub";
import { registry } from "./registry";
import { HISTORY } from "./fixtures";
import { toHistoryItem } from "./directions/today/adapters";

let flags: Record<string, boolean> = { ...registry.today.flags };

export const currentFlags = (): Record<string, boolean> => flags;

export function setLabFlags(next: Record<string, boolean>): void {
  flags = { ...next };
}

export function registerFeatureRoutes(): void {
  registerApiRoute((pathname) => (pathname.endsWith("/attention/history") ? { items: HISTORY.map(toHistoryItem), nextCursor: null } : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/projects") ? [] : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/agents") ? [] : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/attention") ? emptyFeed() : undefined));
}

function emptyFeed() {
  return {
    companyId: registry.shell.company.id,
    generatedAt: "2026-09-28T18:00:00.000Z",
    totalCount: 0,
    deskBadgeCount: 0,
    viewCounts: { mine: 0, unassigned: 0, company: 0, archived: 0, all: 0 },
    nextCursor: null,
    countsBySourceKind: {},
    items: [],
    receipts: [],
  };
}

registerApiRoute((pathname) => (pathname.endsWith("/instance/settings/experimental") ? currentFlags() : undefined));
registerFeatureRoutes();
