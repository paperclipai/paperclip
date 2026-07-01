export type IssueChatThreadPresetName = "task" | "assistant";

export type IssueChatThreadVariant = "full" | "embedded";

export type IssueChatThreadDensity = "comfortable" | "compact";

export type IssueChatThreadWorkingIndicator = "expanded" | "collapsed";

export type IssueChatThreadComposerSubmitKey = "mod-enter" | "enter";

export interface IssueChatThreadPresetConfig {
  preset: IssueChatThreadPresetName;
  density: IssueChatThreadDensity;
  workingIndicator: IssueChatThreadWorkingIndicator;
  variant: IssueChatThreadVariant;
  showComposer: boolean;
  showJumpToLatest: boolean;
  autoScrollToLatestOnInitialLoad: boolean;
  emptyMessage: string;
  suppressIssueStatusNotices: boolean;
  enableReassign: boolean;
  showBackgroundWorkChildren: boolean;
  showRunFinalizationActions: boolean;
  composerSubmitKey: IssueChatThreadComposerSubmitKey;
  composerSingleLine: boolean;
  composerMentions: "enabled" | "optional";
}

export interface IssueChatThreadPresetOverrides {
  variant?: IssueChatThreadVariant;
  showComposer?: boolean;
  showJumpToLatest?: boolean;
  autoScrollToLatestOnInitialLoad?: boolean;
  emptyMessage?: string;
  suppressIssueStatusNotices?: boolean;
  enableReassign?: boolean;
  showBackgroundWorkChildren?: boolean;
}

type IssueChatThreadPresetDefinition = Omit<
  IssueChatThreadPresetConfig,
  "preset" | "variant" | "showJumpToLatest" | "emptyMessage"
> & {
  variant: IssueChatThreadVariant;
  showJumpToLatest: (variant: IssueChatThreadVariant) => boolean;
  emptyMessage: (variant: IssueChatThreadVariant) => string;
};

const taskEmptyMessage = (variant: IssueChatThreadVariant) =>
  variant === "embedded"
    ? "No run output yet."
    : "This task conversation is empty. Start with a message below.";

const ISSUE_CHAT_THREAD_PRESETS: Record<IssueChatThreadPresetName, IssueChatThreadPresetDefinition> = {
  task: {
    density: "comfortable",
    workingIndicator: "expanded",
    variant: "full",
    showComposer: true,
    showJumpToLatest: (variant) => variant === "full",
    autoScrollToLatestOnInitialLoad: true,
    emptyMessage: taskEmptyMessage,
    suppressIssueStatusNotices: false,
    enableReassign: false,
    showBackgroundWorkChildren: true,
    showRunFinalizationActions: true,
    composerSubmitKey: "mod-enter",
    composerSingleLine: false,
    composerMentions: "enabled",
  },
  assistant: {
    density: "compact",
    workingIndicator: "collapsed",
    variant: "full",
    showComposer: true,
    showJumpToLatest: () => false,
    autoScrollToLatestOnInitialLoad: true,
    emptyMessage: () => "Send a message to start the conversation.",
    suppressIssueStatusNotices: true,
    enableReassign: false,
    showBackgroundWorkChildren: false,
    showRunFinalizationActions: false,
    composerSubmitKey: "enter",
    composerSingleLine: true,
    composerMentions: "optional",
  },
};

export function resolveIssueChatThreadPreset(
  preset: IssueChatThreadPresetName = "task",
  overrides: IssueChatThreadPresetOverrides = {},
): IssueChatThreadPresetConfig {
  const definition = ISSUE_CHAT_THREAD_PRESETS[preset];
  const variant = overrides.variant ?? definition.variant;

  return {
    preset,
    density: definition.density,
    workingIndicator: definition.workingIndicator,
    variant,
    showComposer: overrides.showComposer ?? definition.showComposer,
    showJumpToLatest: overrides.showJumpToLatest ?? definition.showJumpToLatest(variant),
    autoScrollToLatestOnInitialLoad:
      overrides.autoScrollToLatestOnInitialLoad ?? definition.autoScrollToLatestOnInitialLoad,
    emptyMessage: overrides.emptyMessage ?? definition.emptyMessage(variant),
    suppressIssueStatusNotices:
      overrides.suppressIssueStatusNotices ?? definition.suppressIssueStatusNotices,
    enableReassign: overrides.enableReassign ?? definition.enableReassign,
    showBackgroundWorkChildren:
      overrides.showBackgroundWorkChildren ?? definition.showBackgroundWorkChildren,
    showRunFinalizationActions: definition.showRunFinalizationActions,
    composerSubmitKey: definition.composerSubmitKey,
    composerSingleLine: definition.composerSingleLine,
    composerMentions: definition.composerMentions,
  };
}
