import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  nativeCheckpointRetirement,
  readNativeCheckpointRetirement,
} from "./native-runner-checkpoint-retirement.js";

it.each([
  "foreign_company",
  "foreign_run",
  "duplicate",
  "overflow",
  "missing_agent",
  "future_schema",
  "invalid_time",
  "unknown_key",
])("refuses malformed or foreign checkpoint retirement: %s", (kind) => {
  const companyId = randomUUID(),
    runId = randomUUID();
  const value: Record<string, unknown> = nativeCheckpointRetirement({
    companyId,
    runIds: [runId],
    agentId: randomUUID(),
    sessionId: randomUUID(),
  });
  if (kind === "foreign_company") value.companyId = randomUUID();
  if (kind === "foreign_run") value.runIds = [randomUUID()];
  if (kind === "duplicate") value.runIds = [runId, runId];
  if (kind === "overflow")
    value.runIds = [runId, ...Array.from({ length: 100 }, () => randomUUID())];
  if (kind === "missing_agent") delete value.agentId;
  if (kind === "future_schema")
    value.schema = "paperclip.native-runner-checkpoint-retirement.v2";
  if (kind === "invalid_time") value.retiredAt = "not a timestamp";
  if (kind === "unknown_key") value.extra = true;
  expect(() =>
    readNativeCheckpointRetirement(value, { companyId, runId }),
  ).toThrow("native_runner_checkpoint_retirement_invalid");
});
it("keeps ordinary encrypted checkpoint materials outside the retirement contract", () => {
  expect(
    readNativeCheckpointRetirement(
      { provider: "local_encrypted", ciphertext: "existing material" },
      { companyId: randomUUID(), runId: randomUUID() },
    ),
  ).toBeNull();
});
