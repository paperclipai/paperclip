import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePrpFixtureText,
  replayParitySummary,
  reducePrpFixture,
} from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = resolve(packageRoot, "protocol/fixtures/replay");
const goldenDirectory = resolve(fixtureDirectory, "golden");
const fixtureNames = [
  "happy-path",
  "failed-run",
  "interrupted-run",
  "duplicate-event",
  "source-gap",
  "unknown-optional-fields",
  "semantic-tool-artifact-happy-path",
  "semantic-tool-denial-redaction",
  "semantic-tool-conflict-duplicate-retry",
  "semantic-tool-governance-wake-monitor",
  "budget-cost-stop-reason",
  "semantic-tool-unknown-optional-envelope",
];
const check = process.argv.includes("--check");
const stale = [];

await mkdir(goldenDirectory, { recursive: true });
for (const fixtureName of fixtureNames) {
  const source = await readFile(resolve(fixtureDirectory, `${fixtureName}.json`), "utf8");
  const validation = parsePrpFixtureText(source);
  if (!validation.ok) {
    throw new Error(
      `${fixtureName}.json failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const snapshot = reducePrpFixture(validation.fixture);
  const outputs = [
    ["snapshot", snapshot],
    ["summary", replayParitySummary(snapshot)],
  ];
  for (const [kind, value] of outputs) {
    const path = resolve(goldenDirectory, `${fixtureName}.${kind}.json`);
    const generated = `${JSON.stringify(value, null, 2)}\n`;
    if (check) {
      if ((await readFile(path, "utf8").catch(() => "")) !== generated) {
        stale.push(`${fixtureName}.${kind}.json`);
      }
    } else {
      await writeFile(path, generated);
    }
  }
}

if (stale.length > 0) {
  process.stderr.write(`Replay golden files are stale:\n- ${stale.join("\n- ")}\n`);
  process.exitCode = 1;
} else if (check) {
  process.stdout.write("Replay golden snapshots and parity summaries are current.\n");
} else {
  process.stdout.write("Generated Replay golden snapshots and parity summaries.\n");
}
