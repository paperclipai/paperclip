import { summarizeExecutionBilling } from "./billing.js";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeFirstTask, pendingQuality } from "./first-task-quality.js";
import { assertSecretFree } from "./redaction.js";
import { validateRetainedRunnerResult } from "./result-validation.js";

export async function main(args: string[]) {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--result", "--max-dollars"].includes(args[i]) ||
      !args[i + 1] ||
      options[args[i]]
    )
      throw new Error("Usage: --result path/to/result.json --max-dollars 0.50");
    options[args[i]] = args[i + 1];
  }
  if (!options["--result"]) throw new Error("--result is required");
  const target = path.resolve(options["--result"]);
  const original = await readFile(target, "utf8");
  const result: unknown = JSON.parse(original);
  validateRetainedRunnerResult(result);
  if (result.suiteId !== "first-task" || !result.firstTask)
    throw new Error("Only first-task recordings can be judged");
  if (result.firstTaskQuality)
    throw new Error(
      "A judge attempt is already recorded; use a separate campaign for another judgment",
    );
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing credential OPENAI_API_KEY");
  assertSecretFree(original, [apiKey], "judge input");
  const pending = pendingQuality(
    result.firstTask,
    Number(options["--max-dollars"]),
  );
  // Exclusive ledger prevents concurrent/repeated spending, including crash recovery.
  const ledger = `${target}.judge.json`;
  await writeFile(ledger, JSON.stringify(pending, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  const pendingResult = { ...result, firstTaskQuality: pending };
  const reserved = JSON.stringify(
    { ...pendingResult, billing: summarizeExecutionBilling(pendingResult) },
    null,
    2,
  );
  await writeFile(`${target}.judge.tmp`, reserved);
  await rename(`${target}.judge.tmp`, target);
  const quality = await judgeFirstTask(result.firstTask, pending, apiKey);
  assertSecretFree(JSON.stringify(quality), [apiKey], "judge output");
  await writeFile(ledger, JSON.stringify(quality, null, 2));
  if ((await readFile(target, "utf8")) !== reserved)
    throw new Error(
      "Result changed while judging; judgment retained in ledger, result not overwritten",
    );
  const enriched = { ...result, firstTaskQuality: quality };
  const updated = JSON.stringify(
    { ...enriched, billing: summarizeExecutionBilling(enriched) },
    null,
    2,
  );
  await writeFile(`${target}.judge.tmp`, updated);
  await rename(`${target}.judge.tmp`, target);
  console.log(
    `Quality ${quality.status}; estimated spend ${quality.estimatedCostUsd ?? "unavailable"}; reserved $${quality.reservedCostUsd.toFixed(6)}. Behavioral verdict unchanged. Regenerate the dashboard to display it.`,
  );
  if (quality.status !== "completed") process.exitCode = 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2).filter((a) => a !== "--")).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
