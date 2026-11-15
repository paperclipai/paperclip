/**
 * Help text for memory upgrade filter subcommand (TECH-8572).
 */

export function printFilterHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade filter --manifest <path> --jsonl <path> --output-dir <dir> [options]

Filters low-value (transient/operational) records from an exported memory JSONL+manifest pair.
Applies deterministic prefiltering (Stage 1) followed by LLM classification (Stage 2).
Files are written with mode 0600 into an atomic staging directory ending in COMPLETE.

Required:
  --manifest <path>              Input export manifest JSON path
  --jsonl <path>                 Input export JSONL path
  --output-dir <dir>             Output directory for filtered JSONL, manifest, and audit reports

Options:
  --company <uuid>               Target company UUID (verified against manifest)
  --agent <uuid>                 Target agent UUID (verified against manifest)
  --upgrade-id <uuid>            Target upgrade UUID (verified against manifest)
  --openai-key-file <path>       External 0600 key file path (outside repo)
  --model <name>                 Classifier model (default: "gpt-5.4-mini")
  --max-cost-usd <num>           Maximum classification budget in USD (default: 2)
  --concurrency <int>            Concurrency for classifier stage (default: 4, range: 1..16)
  --chat-rpm <int>               Chat completions rate limit cap (RPM, default: 500)
  --chat-tpm <int>               Chat completions token limit cap (TPM, default: 200,000)
  --keep-import-keys <path>      File containing UUID import keys to force-keep (one per line)
  --confirm <company-uuid>       Confirmation of target company UUID to write output files
  --dry-run                      Run in dry-run mode (no files written, model skipped if no key)
  --format <text|json>           Output report format (default: "text")
  --control-plane-url <dsn>      Paperclip control-plane DSN to resolve company_secrets
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
