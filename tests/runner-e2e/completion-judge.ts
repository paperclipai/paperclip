import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSecretFree } from "./redaction.js";
import { judgeCompletionQuality, reserveCompletionQuality } from "./completion-quality.js";

/** Preserve the original attempt; create an exclusive, versioned semantic-evidence sidecar. */
export async function main(args: string[]) {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--evidence", "--max-dollars", "--approve-external-judge"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Usage: --evidence completion-update.json --max-dollars 0.50");
    options[args[i]] = args[i + 1];
  }
  if (!options["--evidence"]) throw new Error("--evidence is required");
  if (options["--approve-external-judge"] !== "yes") throw new Error("Explicit approval to send sanitized fixture evidence is required");
  const secrets = Object.entries(process.env).filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && value && value.length >= 8).map(([, value]) => value!);
  const apiKey = process.env.OPENAI_API_KEY?.trim(); if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  const target = resolve(options["--evidence"]), original = await readFile(target, "utf8");
  assertSecretFree(original, [apiKey], "completion judge input");
  const evidence = JSON.parse(original);
  if (!evidence.observation || !evidence.schema?.startsWith("paperclip.completion-update-probe.")) throw new Error("Expected a retained completion probe");
  const pending = reserveCompletionQuality(evidence.observation, Number(options["--max-dollars"]), secrets);
  const sidecar = `${target}.quality.json`;
  await writeFile(sidecar, JSON.stringify(pending, null, 2), { flag: "wx", mode: 0o600 });
  const result = await judgeCompletionQuality(evidence.observation, pending, apiKey, undefined, { approvedFixture: true, secrets });
  assertSecretFree(JSON.stringify(result), [apiKey], "completion judge output");
  await writeFile(sidecar, JSON.stringify(result, null, 2));
  if (result.status !== "completed" || !result.passed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => { console.error("Completion judgment failed; retained evidence was not changed."); process.exitCode = 1; });
