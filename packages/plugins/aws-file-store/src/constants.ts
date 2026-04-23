export const PLUGIN_ID = "paperclip-aws-file-store";
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  writeFile: "fs-write",
  readFile: "fs-read",
  listDir: "fs-list",
  treeDir: "fs-tree",
  mkdir: "fs-mkdir",
  move: "fs-move",
  remove: "fs-remove",
  stat: "fs-stat",
  search: "fs-search",
} as const;

export const STATE_KEYS = {
  fileIndex: "file-index",
} as const;

export const DEFAULT_CONFIG = {
  s3Bucket: "paperclip",
  s3Region: "us-east-1",
  s3Endpoint: "http://localhost:9000",
  s3Prefix: "file-store",
  s3ForcePathStyle: true,
  maxFileSizeMb: 50,
  maxTreeDepth: 10,
} as const;

/**
 * Standard directory structure created per organization.
 * - knowledge-base: curated documents agents use for work (originals + markdown versions)
 * - income: incoming files agents triage, convert to markdown, and move into knowledge-base
 */
export const ORG_DIRS = {
  knowledgeBase: "knowledge-base",
  income: "income",
} as const;
