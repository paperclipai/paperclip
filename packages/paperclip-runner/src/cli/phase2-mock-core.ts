import { writeFile } from "node:fs/promises";

import {
  PHASE2_SCENARIOS,
  phase2TraceAsFixture,
  runPhase2Scenario,
  type Phase2Scenario,
} from "../mock-core/phase2-local-runner.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenarioInput = argument("--scenario") ?? "happy-path";
if (!PHASE2_SCENARIOS.includes(scenarioInput as Phase2Scenario)) {
  process.stderr.write(
    `Unknown scenario ${scenarioInput}. Choose ${PHASE2_SCENARIOS.join(", ")}.\n`,
  );
  process.exitCode = 1;
} else {
  const scenario = scenarioInput as Phase2Scenario;
  const trace = await runPhase2Scenario({
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
    await writeFile(outputPath, `${JSON.stringify(phase2TraceAsFixture(trace), null, 2)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({
      schema: "paperclip.runner.phase2.summary.v1",
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
