import type { BrainEntityType } from "../api/brain";

export const ENTITY_TYPE_COLORS: Record<BrainEntityType, string> = {
  person: "#3b82f6",
  company: "#22c55e",
  deal: "#f59e0b",
  project: "#a855f7",
  ticket: "#ef4444",
  invoice: "#ec4899",
  meeting: "#14b8a6",
  concept: "#6b7280",
  summary: "#78716c",
};

export const ENTITY_TYPE_LABELS: Record<BrainEntityType, string> = {
  person: "People",
  company: "Companies",
  deal: "Deals",
  project: "Projects",
  ticket: "Tickets",
  invoice: "Invoices",
  meeting: "Meetings",
  concept: "Concepts",
  summary: "Summaries",
};

export const ENTITY_TYPE_BG: Record<BrainEntityType, string> = {
  person: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  company: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  deal: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  project: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  ticket: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  invoice: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400",
  meeting: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
  concept: "bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-400",
  summary: "bg-stone-100 text-stone-800 dark:bg-stone-800/50 dark:text-stone-400",
};

export const ALL_ENTITY_TYPES: BrainEntityType[] = [
  "person",
  "company",
  "deal",
  "project",
  "ticket",
  "invoice",
  "meeting",
  "concept",
  "summary",
];

export function entityTypeLabel(type: BrainEntityType): string {
  return ENTITY_TYPE_LABELS[type] ?? type;
}
