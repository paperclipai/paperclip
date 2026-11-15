/**
 * Allowed flags for filter subcommand (TECH-8572).
 */

export const BOOLEAN_FILTER_FLAGS = new Set([
  "--dry-run",
  "--prod",
  "--help",
  "-h",
]);

export const ALLOWED_FILTER_FLAGS = new Set([
  ...BOOLEAN_FILTER_FLAGS,
  "--manifest",
  "--jsonl",
  "--output-dir",
  "--company",
  "--agent",
  "--upgrade-id",
  "--openai-key-file",
  "--model",
  "--max-cost-usd",
  "--confirm",
  "--keep-import-keys",
  "--format",
  "--control-plane-url",
  "--concurrency",
  "--chat-rpm",
  "--chat-tpm",
]);
