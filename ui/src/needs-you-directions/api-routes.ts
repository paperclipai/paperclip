import { ATTENTION_SOURCE_KINDS, type AttentionSourceKind } from "@paperclipai/shared";
import { registerApiRoute } from "./api-stub";
import { registry } from "./registry";
import { FEED_RECORDS, HISTORY, RECEIPTS, VIEW_COUNTS } from "./fixtures";
import { toAttentionItem, toHistoryItem, toReceipt, USER_LABELS, VIEWER_ID } from "./directions/today/adapters";
import { COORDINATOR_INTERACTION_ATTENTION, COORDINATOR_INTERACTIONS, COORDINATOR_PLAN_DOCUMENT } from "./directions/today/coordinator-fixtures";

const INTERACTION_KINDS = new Set(["plan", "confirmation", "question", "suggested_tasks", "decision"]);

let flags: Record<string, boolean> = { ...registry.today.flags };

export const currentFlags = (): Record<string, boolean> => ({ ...flags, enableAgentChat: true });

export function setLabFlags(next: Record<string, boolean>): void {
  flags = { ...next };
}

const companyId = registry.shell.company.id;

function attentionFeed() {
  const items = [
    ...COORDINATOR_INTERACTION_ATTENTION,
    ...FEED_RECORDS.filter((record) => !INTERACTION_KINDS.has(record.kind)).map(toAttentionItem),
  ];
  const countsBySourceKind = Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<AttentionSourceKind, number>;
  for (const item of items) countsBySourceKind[item.sourceKind] += 1;
  return {
    companyId,
    generatedAt: "2026-09-28T18:00:00.000Z",
    totalCount: items.length,
    deskBadgeCount: VIEW_COUNTS.mine,
    viewCounts: VIEW_COUNTS,
    nextCursor: null,
    countsBySourceKind,
    items,
    receipts: RECEIPTS.map(toReceipt),
  };
}

function session() {
  return {
    session: { id: "lab-session", userId: VIEWER_ID },
    user: { id: VIEWER_ID, name: "Scott", email: "scott@acmehats.example", image: null },
    sentryDsn: null,
    sentryEnvironment: null,
  };
}

function workspacePreference() {
  return { userId: VIEWER_ID, coordinatorWorkspaceEnabled: true, updatedAt: "2026-09-28T18:00:00.000Z" };
}

function boardAccess() {
  return {
    user: { id: VIEWER_ID, email: "scott@acmehats.example", name: "Scott", image: null },
    userId: VIEWER_ID,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    source: "local_implicit",
    keyId: null,
  };
}

function userDirectory() {
  return { users: [...USER_LABELS].map(([id, name]) => ({ principalId: id, status: "active", user: { id, name, email: null, image: null } })) };
}

export function registerFeatureRoutes(): void {
  registerApiRoute((pathname) => (pathname.endsWith("/auth/get-session") ? session() : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/workspace-preferences/me") ? workspacePreference() : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/cli-auth/me") ? boardAccess() : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/attention/history") ? { items: HISTORY.map(toHistoryItem), nextCursor: null } : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/attention") ? attentionFeed() : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/interactions") ? COORDINATOR_INTERACTIONS : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/documents/plan") ? COORDINATOR_PLAN_DOCUMENT : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/user-directory") ? userDirectory() : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/agents") ? [] : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/projects") ? [] : undefined));
  registerApiRoute((pathname) => (pathname.endsWith("/health") ? { deploymentMode: "local_trusted" } : undefined));
}

registerApiRoute((pathname) => (pathname.endsWith("/instance/settings/experimental") ? currentFlags() : undefined));
registerFeatureRoutes();
