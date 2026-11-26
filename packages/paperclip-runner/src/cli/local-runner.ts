import { writeFile } from "node:fs/promises";

import {
  LOCAL_RUNNER_SCENARIOS,
  localRunnerTraceAsFixture,
  runLocalRunnerScenario,
  type LocalRunnerScenario,
} from "../mock-core/local-runner.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenarioInput = argument("--scenario") ?? "happy-path";
if (!LOCAL_RUNNER_SCENARIOS.includes(scenarioInput as LocalRunnerScenario)) {
  process.stderr.write(
    `Unknown scenario ${scenarioInput}. Choose ${LOCAL_RUNNER_SCENARIOS.join(", ")}.\n`,
  );
  process.exitCode = 1;
} else {
  const scenario = scenarioInput as LocalRunnerScenario;
  const trace = await runLocalRunnerScenario({
    scenario,
    duplicateTurnCommand: process.argv.includes("--duplicate-turn-command"),
    onEvent(event) {
      if (!process.argv.includes("--quiet")) {
        process.stdout.write(
          `${String(event.sourceSeq).padStart(2, "0")} ${event.eventType}\n`,
        );
      }
    },
  });
  const outputPath = argument("--output");
  if (outputPath !== undefined) {
    await writeFile(outputPath, `${JSON.stringify(localRunnerTraceAsFixture(trace), null, 2)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({
      schema: "paperclip.runner.local-runner.summary.v1",
      scenario,
      eventCount: trace.events.length,
      terminalCount: trace.events.filter((event) => event.eventType === "run.terminal").length,
      semanticResult: trace.result?.reportedWorkDisposition ?? null,
      harnessProcessExit: trace.harnessProcessExit,
      runnerProcessExit: trace.runnerProcessExit,
      outputPath: outputPath ?? null,
    })}\n`,
  );
}
