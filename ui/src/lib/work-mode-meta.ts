import type { IssueWorkMode } from "@paperclipai/shared";
import { ClipboardList, Hammer, MessageCircleQuestion, type LucideIcon } from "lucide-react";

export type WorkModeTone = "neutral" | "ask" | "planning";

export interface WorkModeMeta {
  value: IssueWorkMode;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  tone: WorkModeTone;
  classes: {
    chip: string;
    container: string;
    menuItem: string;
    badge: string;
  };
}

const STANDARD_CLASSES = {
  chip: "border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground",
  container: "",
  menuItem: "text-foreground",
  badge: "",
};

const ASK_CLASSES = {
  chip: "border-sky-500/60 bg-sky-500/15 text-sky-800 hover:bg-sky-500/25 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25",
  container: "border-sky-500/60 bg-sky-50/60 supports-[backdrop-filter]:bg-sky-50/40 dark:border-sky-500/50 dark:bg-sky-500/[0.07] dark:supports-[backdrop-filter]:bg-sky-500/[0.07]",
  menuItem: "text-sky-700 dark:text-sky-300",
  badge: "border-sky-500/40 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200",
};

const PLANNING_CLASSES = {
  chip: "border-amber-500/60 bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25",
  container: "border-amber-500/60 bg-amber-50/60 supports-[backdrop-filter]:bg-amber-50/40 dark:border-amber-500/50 dark:bg-amber-500/[0.07] dark:supports-[backdrop-filter]:bg-amber-500/[0.07]",
  menuItem: "text-amber-700 dark:text-amber-300",
  badge: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export function isIssueWorkMode(value: unknown): value is IssueWorkMode {
  return value === "standard" || value === "ask" || value === "planning";
}

export function workModeMetaList(conferenceRoomChat: boolean): WorkModeMeta[] {
  return [
    {
      value: "standard",
      label: conferenceRoomChat ? "Agent mode" : "Standard",
      shortLabel: conferenceRoomChat ? "Agent" : "Standard",
      icon: Hammer,
      tone: "neutral",
      classes: STANDARD_CLASSES,
    },
    {
      value: "planning",
      label: conferenceRoomChat ? "Plan mode" : "Planning",
      shortLabel: conferenceRoomChat ? "Plan" : "Planning",
      icon: ClipboardList,
      tone: "planning",
      classes: PLANNING_CLASSES,
    },
    {
      value: "ask",
      label: conferenceRoomChat ? "Ask mode" : "Ask",
      shortLabel: "Ask",
      icon: MessageCircleQuestion,
      tone: "ask",
      classes: ASK_CLASSES,
    },
  ];
}

export function workModeMetaFor(mode: IssueWorkMode, conferenceRoomChat: boolean): WorkModeMeta {
  const modes = workModeMetaList(conferenceRoomChat);
  return modes.find((meta) => meta.value === mode) ?? modes[0]!;
}

export function nextWorkMode(mode: IssueWorkMode, conferenceRoomChat: boolean): IssueWorkMode {
  const modes = workModeMetaList(conferenceRoomChat);
  const index = modes.findIndex((meta) => meta.value === mode);
  return modes[(index + 1) % modes.length]?.value ?? "standard";
}

export function titleForPendingWorkMode(mode: IssueWorkMode, conferenceRoomChat: boolean): string {
  if (mode === "ask") {
    return "Ask mode for this submission. Click to change. The assignee will answer in this thread; no implementation work.";
  }
  if (mode === "planning") {
    return `${conferenceRoomChat ? "Plan" : "Planning"} mode is on for this submission. Click to change.`;
  }
  return `${conferenceRoomChat ? "Agent" : "Standard"} mode for this submission. Click to change.`;
}
