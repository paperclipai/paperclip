export const PLUGIN_ID = "paperclip-issue-links";
export const PLUGIN_VERSION = "0.1.0";

export const SLOT_IDS = {
  issueLinksView: "issue-links-view",
} as const;

export const EXPORT_NAMES = {
  issueLinksView: "IssueLinksView",
} as const;

export const TOOL_NAMES = {
  setLocalPath: "issue-links.set-local-path",
  setGithubPrUrl: "issue-links.set-github-pr-url",
} as const;

export const STATE_KEYS = {
  localPath: "localPath",
  githubPrUrl: "githubPrUrl",
} as const;

export const DEFAULT_CONFIG = {
  openWith: "vscode" as "vscode" | "finder",
} as const;
