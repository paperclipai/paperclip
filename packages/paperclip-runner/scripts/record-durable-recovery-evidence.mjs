import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DURABLE_RECOVERY_FAULTS, runDurableRecoveryRecovery } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const evidenceRoot = resolve(packageRoot, "knowledge/evidence");
const faultRoot = resolve(evidenceRoot, "durable-recovery-faults");
mkdirSync(faultRoot, { recursive: true });

const summaries = [];
for (const fault of DURABLE_RECOVERY_FAULTS) {
  const trace = await runDurableRecoveryRecovery({ fault });
  writeFileSync(
    resolve(faultRoot, `${fault}.json`),
    `${JSON.stringify(trace, null, 2)}\n`,
  );
  if (fault === "lost-ack") {
    writeFileSync(
      resolve(evidenceRoot, "durable-recovery-trace.json"),
      `${JSON.stringify(trace, null, 2)}\n`,
    );
  }
  summaries.push({
    fault,
    outcome: trace.diagnostics.recovery.outcome,
    connectionCount: trace.diagnostics.connection.connectionCount,
    replayDeliveries: trace.diagnostics.recovery.replayDeliveries,
    runnerRestarts: trace.diagnostics.recovery.runnerRestarts,
    harnessRestarts: trace.diagnostics.recovery.harnessRestarts,
    commands: trace.diagnostics.commands,
    outbox: trace.diagnostics.outbox,
    security: trace.diagnostics.security,
    assertions: trace.assertions,
  });
}

writeFileSync(
  resolve(evidenceRoot, "durable-recovery-fault-matrix.json"),
  `${JSON.stringify({ schema: "paperclip.runner.durable.evidence.v1", traces: summaries }, null, 2)}\n`,
);

const passed = summaries.every((summary) =>
  Object.values(summary.assertions).every(Boolean),
);
process.stdout.write(
  `Recorded ${summaries.length} Durable recovery fault traces; every trace passed: ${passed}.\n`,
);
