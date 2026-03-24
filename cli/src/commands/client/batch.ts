import { Command } from "commander";
import pc from "picocolors";
import { addCommonClientOptions, resolveCommandContext, printOutput } from "./common.js";
import type { BaseClientOptions } from "./common.js";

interface BatchQueueOptions extends BaseClientOptions {
  status?: string;
  limit?: number;
  agent?: string;
  company?: string;
  json?: boolean;
}

interface BatchQueueResponse {
  summary: {
    total: number;
    pending: number;
    submitted: number;
    completed: number;
    failed: number;
    expired: number;
    cancelled: number;
  };
  entries: Array<{
    id: string;
    customId: string;
    agentId: string;
    companyId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    batchJobId: string | null;
    errorMessage: string | null;
  }>;
  jobs: Array<{
    id: string;
    anthropicBatchId: string;
    status: string;
    entryCount: number;
    submittedAt: string;
    lastPolledAt: string | null;
    endedAt: string | null;
    errorMessage: string | null;
  }>;
}

function formatQueueTable(data: BatchQueueResponse): string {
  const lines: string[] = [];

  // Summary section
  lines.push(pc.bold("📊 Batch Queue Summary"));
  lines.push("─".repeat(60));

  const summary = data.summary;
  const total = summary.total;
  const progressBar = createProgressBar(total, summary);
  lines.push(`Total entries: ${pc.bold(String(total))}`);
  lines.push(progressBar);
  lines.push("");

  // Status breakdown
  lines.push(pc.bold("Status Breakdown:"));
  const statuses = [
    { label: "Pending", count: summary.pending, color: pc.yellow },
    { label: "Submitted", count: summary.submitted, color: pc.cyan },
    { label: "Completed", count: summary.completed, color: pc.green },
    { label: "Failed", count: summary.failed, color: pc.red },
    { label: "Expired", count: summary.expired, color: pc.gray },
    { label: "Cancelled", count: summary.cancelled, color: pc.gray },
  ];

  for (const s of statuses) {
    if (s.count > 0) {
      const pct = ((s.count / Math.max(total, 1)) * 100).toFixed(1);
      lines.push(`  ${s.color(`●`)} ${s.label.padEnd(12)} ${String(s.count).padStart(3)} (${pct}%)`);
    }
  }
  lines.push("");

  // Active jobs section
  if (data.jobs.length > 0) {
    lines.push(pc.bold("🔄 In-Progress Anthropic Batch Jobs"));
    lines.push("─".repeat(60));
    for (const job of data.jobs) {
      lines.push(`ID: ${pc.cyan(job.id)}`);
      lines.push(`  Anthropic ID: ${job.anthropicBatchId}`);
      lines.push(`  Status: ${job.status}`);
      lines.push(`  Entries: ${job.entryCount}`);
      lines.push(`  Submitted: ${new Date(job.submittedAt).toLocaleString()}`);
      if (job.lastPolledAt) {
        lines.push(`  Last Polled: ${new Date(job.lastPolledAt).toLocaleString()}`);
      }
      lines.push("");
    }
  }

  // Recent entries
  if (data.entries.length > 0) {
    lines.push(pc.bold("📋 Recent Queue Entries"));
    lines.push("─".repeat(60));

    // Table header
    const headers = ["Status", "Agent ID", "Custom ID", "Created", "Updated"];
    const colWidths = [12, 8, 20, 20, 20];
    lines.push(
      headers
        .map((h, i) => pc.bold(h.padEnd(colWidths[i])))
        .join("")
    );
    lines.push("─".repeat(80));

    // Table rows
    for (const entry of data.entries.slice(0, 10)) {
      const statusColor =
        entry.status === "completed"
          ? pc.green
          : entry.status === "failed"
            ? pc.red
            : entry.status === "pending"
              ? pc.yellow
              : entry.status === "submitted"
                ? pc.cyan
                : pc.gray;

      const createdTime = new Date(entry.createdAt);
      const minutesAgo = Math.floor((Date.now() - createdTime.getTime()) / 60000);
      const timeStr = minutesAgo < 60 ? `${minutesAgo}m ago` : createdTime.toLocaleTimeString();

      lines.push(
        `${statusColor(entry.status.padEnd(12))} ${entry.agentId.slice(0, 8).padEnd(8)} ${entry.customId.slice(0, 20).padEnd(20)} ${timeStr.padEnd(20)}`
      );
    }

    if (data.entries.length > 10) {
      lines.push(`... and ${data.entries.length - 10} more entries`);
    }
  } else {
    lines.push(pc.green("✓ Batch queue is empty"));
  }

  return lines.join("\n");
}

function createProgressBar(total: number, summary: BatchQueueResponse["summary"]): string {
  const barWidth = 40;
  const pending = (summary.pending / Math.max(total, 1)) * barWidth;
  const submitted = (summary.submitted / Math.max(total, 1)) * barWidth;
  const completed = (summary.completed / Math.max(total, 1)) * barWidth;
  const failed = (summary.failed / Math.max(total, 1)) * barWidth;

  let bar = "";
  bar += pc.yellow("█".repeat(Math.round(pending)));
  bar += pc.cyan("█".repeat(Math.round(submitted)));
  bar += pc.green("█".repeat(Math.round(completed)));
  bar += pc.red("█".repeat(Math.round(failed)));
  bar += "░".repeat(Math.max(0, barWidth - Math.round(pending + submitted + completed + failed)));

  return `[${bar}]`;
}

export function registerBatchCommands(program: Command): void {
  const batch = program.command("batch").description("Batch queue operations");

  // Batch queue monitor command
  addCommonClientOptions(
    batch
      .command("queue")
      .aliases(["q", "monitor"])
      .description("Monitor batch request queue status")
      .option(
        "--status <status>",
        "Filter by status (pending, submitted, completed, failed, expired, cancelled)"
      )
      .option("--agent <agentId>", "Filter by agent ID")
      .option("--company <companyId>", "Filter by company ID")
      .option("--limit <n>", "Maximum entries to display", "20")
      .option("--watch", "Watch mode - refresh every 5 seconds")
      .action(async (opts: BatchQueueOptions & { watch?: boolean }) => {
        const ctx = resolveCommandContext(opts);

        const queryParams = new URLSearchParams();
        if (opts.status) queryParams.append("status", opts.status);
        if (opts.agent) queryParams.append("agentId", opts.agent);
        if (opts.company) queryParams.append("companyId", opts.company);
        queryParams.append("limit", opts.limit || "20");

        const url = `/api/admin/batch/queue?${queryParams.toString()}`;

        if (opts.watch) {
          console.clear();
          console.log(pc.cyan("🔄 Batch Queue Monitor (watching - press Ctrl+C to exit)\n"));

          const refreshInterval = setInterval(async () => {
            try {
              console.clear();
              console.log(pc.cyan("🔄 Batch Queue Monitor (watching - press Ctrl+C to exit)\n"));
              const data = await ctx.api.get<BatchQueueResponse>(url);
              console.log(formatQueueTable(data));
              console.log(pc.gray(`\nLast updated: ${new Date().toLocaleTimeString()}`));
            } catch (err) {
              console.error(pc.red("Failed to fetch batch queue data"));
              clearInterval(refreshInterval);
              process.exit(1);
            }
          }, 5000);

          try {
            const data = await ctx.api.get<BatchQueueResponse>(url);
            console.log(formatQueueTable(data));
            console.log(pc.gray(`\nLast updated: ${new Date().toLocaleTimeString()}`));
          } catch (err) {
            console.error(pc.red("Failed to fetch batch queue data"));
            clearInterval(refreshInterval);
            process.exit(1);
          }
        } else {
          try {
            const data = await ctx.api.get<BatchQueueResponse>(url);

            if (opts.json) {
              printOutput(data, { json: true });
            } else {
              console.log(formatQueueTable(data));
            }
          } catch (err) {
            console.error(pc.red("Failed to fetch batch queue data"));
            process.exit(1);
          }
        }
      }),
    { includeCompany: false }
  );
}
