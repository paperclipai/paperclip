#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  DURABLE_RECOVERY_FAULTS,
  type DurableRecoveryFault,
  type DurableRecoveryRunTrace,
} from "../contracts/durable-recovery.js";
import { runDurableRecoveryRecovery } from "../mock-core/durable-recovery.js";

interface CliOptions {
  fault: DurableRecoveryFault;
  json: boolean;
  output: string | null;
  stateDirectory: string | null;
  keepState: boolean;
}

function optionValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseOptions(args: readonly string[]): CliOptions {
  const fault = optionValue(args, "--fault") ?? "lost-ack";
  if (!DURABLE_RECOVERY_FAULTS.includes(fault as DurableRecoveryFault)) {
    throw new Error(
      `--fault must be one of: ${DURABLE_RECOVERY_FAULTS.join(", ")}`,
    );
  }
  return {
    fault: fault as DurableRecoveryFault,
    json: args.includes("--json"),
    output: optionValue(args, "--output"),
    stateDirectory: optionValue(args, "--state-dir"),
    keepState: args.includes("--keep-state"),
  };
}

function assertionLine(name: string, passed: boolean): string {
  return `${passed ? "PASS" : "FAIL"} ${name}`;
}

export function formatDurableRecoveryDiagnostics(trace: DurableRecoveryRunTrace): string {
  const { diagnostics, assertions } = trace;
  const lines = [
    `Durable recovery: ${diagnostics.fault}`,
    `Outcome: ${diagnostics.recovery.outcome} (${diagnostics.recovery.reason})`,
    `Connection: ${diagnostics.connection.state}; ${diagnostics.connection.connectionCount} connection(s), ${diagnostics.connection.reconnectCount} reconnect(s)`,
    `Lease: ${diagnostics.connection.leaseId ?? "none"}; expires ${diagnostics.connection.leaseExpiresAt ?? "not available"}`,
    `Identity: runner=${diagnostics.identity.runnerInstanceId} session=${diagnostics.identity.normalizedSessionId} turn=${diagnostics.identity.turnId} item=${diagnostics.identity.itemId}`,
    `Cursors: runner ACK ${diagnostics.cursors.runnerAckedSourceSeq}; core ACK ${diagnostics.cursors.coreAckedSourceSeq}; next source ${diagnostics.cursors.runnerNextSourceSeq}`,
    `Outbox: ${diagnostics.outbox.events} pending / ${diagnostics.outbox.bytes} bytes; peak ${diagnostics.outbox.peakBytes} / ${diagnostics.outbox.maxBytes}; P0 lost ${diagnostics.outbox.p0Lost}`,
    `Commands: ${diagnostics.commands.completed} completed, ${diagnostics.commands.rejected} rejected, ${diagnostics.commands.duplicateDeliveries} duplicate delivery(s), ${diagnostics.commands.logicalEffects} logical effect(s)`,
    `Recovery: ${diagnostics.recovery.replayDeliveries} replay delivery(s), ${diagnostics.recovery.runnerRestarts} runner restart(s), ${diagnostics.recovery.harnessRestarts} harness restart(s)`,
    `Security: ${diagnostics.security.secretLeakCount} persisted secret leak(s)`,
    "Assertions:",
    assertionLine("stable identity", assertions.stableIdentity),
    assertionLine("source cursor continuity", assertions.sourceCursorContinuous),
    assertionLine(
      "one logical effect per accepted command",
      assertions.oneLogicalEffectPerAcceptedCommand,
    ),
    assertionLine("no duplicate logical events", assertions.noDuplicateLogicalEvents),
    assertionLine("P0 events preserved", assertions.p0Preserved),
    assertionLine("bounded storage", assertions.boundedStorage),
    assertionLine("secrets redacted", assertions.secretsRedacted),
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const trace = await runDurableRecoveryRecovery({
    fault: options.fault,
    stateDirectory:
      options.stateDirectory === null ? undefined : resolve(options.stateDirectory),
    keepState: options.keepState,
  });
  if (options.output !== null) {
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(trace, null, 2)}\n`);
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(trace, null, 2)}\n` : formatDurableRecoveryDiagnostics(trace),
  );
  if (Object.values(trace.assertions).some((passed) => !passed)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `durable-recovery: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
