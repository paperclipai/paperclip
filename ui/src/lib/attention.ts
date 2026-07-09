import {
  AlertTriangle,
  Ban,
  DollarSign,
  Eye,
  LifeBuoy,
  MessageSquareQuote,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AttentionFeed, AttentionItem, AttentionSeverity, AttentionSourceKind } from "@paperclipai/shared";

/**
 * Source kinds the queue can fully resolve in-row. Everything else deep-links
 * to its native surface — reviews are *never* inline (converged PAP-12628),
 * and the remaining state-derived sources (recovery, failures, budget) expose
 * verbs too rich to safely inline here, so they open their surface.
 */
export const INLINE_RESOLVABLE_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set<AttentionSourceKind>([
  "approval",
  "issue_thread_interaction",
  "join_request",
]);

export function isInlineResolvable(item: AttentionItem): boolean {
  return item.inlineResolvable && INLINE_RESOLVABLE_SOURCE_KINDS.has(item.sourceKind);
}

interface SourceMeta {
  label: string;
  icon: LucideIcon;
}

const SOURCE_META: Record<AttentionSourceKind, SourceMeta> = {
  approval: { label: "Approval", icon: ShieldCheck },
  issue_thread_interaction: { label: "Decision requested", icon: MessageSquareQuote },
  join_request: { label: "Join request", icon: UserPlus },
  recovery_action: { label: "Recovery", icon: LifeBuoy },
  productivity_review: { label: "Productivity review", icon: Zap },
  blocker_attention: { label: "Blocked dependency", icon: Ban },
  review: { label: "Review", icon: Eye },
  failed_run: { label: "Failed run", icon: RefreshCw },
  budget_alert: { label: "Budget", icon: DollarSign },
  agent_error_alert: { label: "Agent error", icon: AlertTriangle },
};

export function sourceMeta(kind: AttentionSourceKind): SourceMeta {
  return SOURCE_META[kind] ?? { label: kind.replaceAll("_", " "), icon: AlertTriangle };
}

interface SeverityStyle {
  /** Left accent bar + dot color. */
  accent: string;
  dot: string;
  label: string;
}

const SEVERITY_STYLE: Record<AttentionSeverity, SeverityStyle> = {
  critical: { accent: "bg-red-500", dot: "bg-red-500", label: "Critical" },
  high: { accent: "bg-orange-500", dot: "bg-orange-500", label: "High" },
  medium: { accent: "bg-yellow-500", dot: "bg-yellow-500", label: "Medium" },
  low: { accent: "bg-blue-500", dot: "bg-blue-500", label: "Low" },
};

export function severityStyle(severity: AttentionSeverity): SeverityStyle {
  return SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.low;
}

/**
 * Decisions-only badge count. Every feed row *is* a pending decision (the
 * server drops anything without a decision verb into Activity, per the §0
 * invariant), and mentions/unread never enter the feed — so the row count is
 * the decisions-only number. `/inbox` keeps its own unread count untouched.
 */
export function attentionBadgeCount(feed: AttentionFeed | null | undefined): number {
  return feed?.items.length ?? 0;
}
