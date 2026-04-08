#!/usr/bin/env npx tsx

import { createDb } from "../packages/db/src/index.js";
import { resolveMigrationConnection } from "../packages/db/src/migration-runtime.js";
import {
  shadowCostBackfillService,
  type ShadowCostBackfillOptions,
  type ShadowCostBackfillPlan,
} from "../server/src/services/shadow-cost-backfill.js";

type ClosableDb = ReturnType<typeof createDb> & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

interface CliOptions extends ShadowCostBackfillOptions {
  apply: boolean;
  configPath?: string;
  help: boolean;
  instanceId?: string;
  json: boolean;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function usage(): string {
  return `Usage: pnpm costs:shadow-backfill -- --company-id <uuid> [options]

Options:
  --company-id <uuid>   Required company scope for the backfill
  --instance-id <id>    Optional Paperclip instance id (for example: sigma5c)
  --config <path>       Optional explicit Paperclip config.json path
  --provider <name>     Optional provider filter
  --biller <name>       Optional biller filter
  --model <name>        Optional exact model filter
  --from <iso-date>     Optional inclusive occurred_at lower bound
  --to <iso-date>       Optional inclusive occurred_at upper bound
  --limit <count>       Optional row limit
  --force               Recompute rows that already have shadow_cost_cents
  --apply               Persist shadow_cost_cents updates (default is dry-run)
  --json                Emit JSON summary
  --help                Show this help

Notes:
  - Only subscription_included rows are considered.
  - cost_cents is never modified.
  - --apply requires the migration that adds cost_events.shadow_cost_cents.
`;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return value;
}

function parseDateArg(value: string, flag: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliUsageError(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    companyId: "",
    apply: false,
    force: false,
    help: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    switch (arg) {
      case "--company-id":
        options.companyId = requireValue(argv, ++index, arg);
        break;
      case "--instance-id":
        options.instanceId = requireValue(argv, ++index, arg);
        break;
      case "--config":
        options.configPath = requireValue(argv, ++index, arg);
        break;
      case "--provider":
        options.provider = requireValue(argv, ++index, arg);
        break;
      case "--biller":
        options.biller = requireValue(argv, ++index, arg);
        break;
      case "--model":
        options.model = requireValue(argv, ++index, arg);
        break;
      case "--from":
        options.from = parseDateArg(requireValue(argv, ++index, arg), arg);
        break;
      case "--to":
        options.to = parseDateArg(requireValue(argv, ++index, arg), arg);
        break;
      case "--limit":
        options.limit = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--force":
        options.force = true;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new CliUsageError(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.companyId.trim().length === 0) {
    throw new CliUsageError("--company-id is required");
  }

  return options;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function printPlan(plan: ShadowCostBackfillPlan, options: CliOptions, connectionSource: string) {
  console.log(`Shadow cost backfill (${options.apply ? "apply" : "dry-run"})`);
  console.log(`Connection source: ${connectionSource}`);
  console.log(`Company: ${options.companyId}`);
  console.log(`Matched rows: ${plan.summary.matchedRowCount}`);
  console.log(`Planned updates: ${plan.summary.updateRowCount}`);
  console.log(`Skipped rows: ${plan.summary.skippedRowCount}`);
  console.log(`Current shadow spend: ${formatCents(plan.summary.totalCurrentShadowCostCents)}`);
  console.log(`Planned shadow spend: ${formatCents(plan.summary.totalProposedShadowCostCents)}`);
  console.log(`Delta shadow spend: ${formatCents(plan.summary.totalDeltaShadowCostCents)}`);

  for (const warning of plan.warnings) {
    console.log(`Warning: ${warning}`);
  }

  const preview = plan.rows.slice(0, 10);
  if (preview.length > 0) {
    console.log("Preview:");
    for (const row of preview) {
      console.log(
        [
          `- ${row.id}`,
          `${row.provider}/${row.model}`,
          `${row.action}`,
          `${formatCents(row.currentShadowCostCents)} -> ${formatCents(row.proposedShadowCostCents)}`,
          `source=${row.source}`,
          row.reason ? `reason=${row.reason}` : null,
        ].filter(Boolean).join(" | "),
      );
    }
  }

  if (plan.rows.length > preview.length) {
    console.log(`... ${plan.rows.length - preview.length} additional rows omitted`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  parsedOptions = options;
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.configPath) {
    process.env.PAPERCLIP_CONFIG = options.configPath;
  }
  if (options.instanceId) {
    process.env.PAPERCLIP_INSTANCE_ID = options.instanceId;
  }

  const connection = await resolveMigrationConnection();
  try {
    const db = createDb(connection.connectionString) as ClosableDb;
    try {
      const service = shadowCostBackfillService(db);
      const plan = await service.plan(options);

      if (options.json) {
        const payload: Record<string, unknown> = {
          mode: options.apply ? "apply" : "dry-run",
          connectionSource: connection.source,
          plan,
        };
        if (options.apply) {
          payload.apply = await service.apply(plan);
        }
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      printPlan(plan, options, connection.source);

      if (!options.apply) {
        console.log("No changes written. Re-run with --apply to persist shadow_cost_cents.");
        return;
      }

      const result = await service.apply(plan);
      console.log(
        `Applied ${result.updatedCount} updates (${formatCents(result.totalDeltaShadowCostCents)} delta shadow spend).`,
      );
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
    }
  } finally {
    await connection.stop();
  }
}

let parsedOptions: CliOptions | null = null;

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const hint =
    message.includes('relation "cost_events" does not exist')
      ? "Target the correct Paperclip instance with --instance-id or --config."
      : null;

  if (parsedOptions?.json) {
    console.error(
      JSON.stringify(
        {
          status: error instanceof CliUsageError ? "invalid_arguments" : "error",
          error: message,
          hint,
        },
        null,
        2,
      ),
    );
    process.exit(error instanceof CliUsageError ? 1 : 2);
  }

  console.error(message);
  if (hint) {
    console.error(`Hint: ${hint}`);
  }

  if (error instanceof CliUsageError) {
    console.error("");
    console.error(usage());
    process.exit(1);
  }

  process.exit(2);
});
