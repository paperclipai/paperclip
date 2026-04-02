/**
 * Public exports for the generators package
 * Phase 2.2: Release-changelog and PR-report generators
 */

// Type exports
export type {
  ChangelogEntry,
  ChangelogFeature,
  DroppedFeatureEntry,
  BreakingChange,
  PRCommentData,
  ReleaseMetadata,
  ReleaseResult,
  ArtifactData,
  ReleaseGeneratorOptions,
} from "./types.js";

// Function exports - Changelog
export { generateChangelogEntry } from "./changelog.js";

// Function exports - PR Comment
export { generatePRComment } from "./pr-comment.js";

// Function exports - Changelog Updater
export {
  appendToChangelog,
  extractVersionFromEntry,
  findVersionInChangelog,
  updateChangelogEntryMetadata,
} from "./changelog-updater.js";

// Function exports - GitHub Poster
export { postPRComment, RateLimitError } from "./github-poster.js";

// Function exports - Paperclip Updater
export {
  updatePaperclipRelease,
  updatePaperclipReleaseStatus,
  getPaperclipReleaseMetadata,
  addPaperclipComment,
} from "./paperclip-updater.js";

// Function exports - Release Generator (orchestrator)
export { generateRelease } from "./release-generator.js";
