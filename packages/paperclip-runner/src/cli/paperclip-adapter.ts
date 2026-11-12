import { runStandaloneStandaloneDemo } from "../standalone/standalone-demo.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const scenario = option("--scenario") ?? "happy-path";
const featureFlagEnabled = option("--feature-flag") === "enabled";
const killSwitchEnabled = option("--kill-switch") === "enabled";

if (scenario !== "happy-path") throw new Error(`Unsupported Standalone mock scenario: ${scenario}`);

const result = await runStandaloneStandaloneDemo({ featureFlagEnabled, killSwitchEnabled });
process.stdout.write(`${JSON.stringify({ ...result, scenario })}\n`);
