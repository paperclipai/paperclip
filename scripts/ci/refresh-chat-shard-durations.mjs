import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const chatSuitesPrefix = "server/src/__tests__/chat-channels/";
export const chatManifest = "scripts/chat-shard-durations.json";
const comment = "Per-file Vitest durations (ms) for server/src/__tests__/chat-channels/*.integration.test.ts used by scripts/run-vitest-stable.mjs (--group general-chat) to balance file-level shards via LPT. Missing files take the partitioner's median weight. Timing changes only partition work; they never skip a test.";

function isChatSuiteFile(file) {
  return typeof file === "string" && file.startsWith(chatSuitesPrefix) && file.endsWith(".test.ts");
}

function discoverChatSuites(repoRoot) {
  const dir = path.join(repoRoot, chatSuitesPrefix);
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => `${chatSuitesPrefix}${entry}`)
    .sort((a, b) => a.localeCompare(b));
}

function profileFileDurations(directory) {
  const totals = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry);
      if (statSync(file).isDirectory()) walk(file);
      else if (/^vitest-.+\.ndjson$/.test(entry)) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (record.kind !== "test" || !isChatSuiteFile(record.file)) continue;
          assert.ok(Number.isFinite(record.duration) && record.duration >= 0 && record.duration <= 3_600_000);
          if (record.status === "passed") {
            totals.set(record.file, (totals.get(record.file) ?? 0) + record.duration);
          }
        }
      }
    }
  };
  walk(directory);
  return totals;
}

export function chatManifestData(inventory, runs, sources) {
  const known = new Set(inventory);
  const samples = new Map();
  for (const runTotals of runs) {
    for (const [file, ms] of runTotals) {
      if (!known.has(file)) continue;
      samples.set(file, [...(samples.get(file) ?? []), ms]);
    }
  }
  const durations = {};
  for (const [file, values] of [...samples].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = values.sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    durations[file] = Math.max(1, Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2));
  }
  return { $comment: comment, unit: "ms", sources, coverage: { measured: Object.keys(durations).length, inventory: inventory.length }, durations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sources = args.filter((arg) => arg.startsWith("--source=")).map((arg) => arg.slice("--source=".length));
  const directories = args.filter((arg) => !arg.startsWith("--"));
  assert.ok(directories.length > 0, "Usage: refresh-chat-shard-durations.mjs [--source=<run url>] <profile artifact directory>...");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const data = chatManifestData(discoverChatSuites(repoRoot), directories.map(profileFileDurations), sources);
  writeFileSync(path.join(repoRoot, chatManifest), JSON.stringify(data, null, 2) + "\n");
  console.log(`${chatManifest}: ${data.coverage.measured} of ${data.coverage.inventory} chat suites measured`);
}
