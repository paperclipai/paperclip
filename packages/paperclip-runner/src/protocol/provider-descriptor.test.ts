import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { providerDescriptorSchema } from "./generated/schema-bundle.js";
import { validatePrpEvent, type PrpEvent } from "./replay-contract.js";

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(providerDescriptorSchema);

describe("provider runtime descriptor", () => {
  it("validates negotiated turn controls in descriptors and capability events", () => {
    const descriptor = { provider: "acpx", driver: "acpx_runtime", agent: "pi", model: "explicit-model",
      requestedModel: "explicit-model", executionKind: "local_process", providerVersion: "0.13.1",
      agentProcessId: 42, acpProtocolVersion: 1, agentServerPackage: "pi-acp", agentServerVersion: "0.0.33",
      acpxRecordId: "record", turnControls: { steering: true, queuedFollowUp: true } };
    expect(validate(descriptor), JSON.stringify(validate.errors)).toBe(true);
    for (const turnControls of [{ steering: "true", queuedFollowUp: true }, { steering: true },
      { steering: true, queuedFollowUp: true, unverified: true }]) {
      expect(validate({ ...descriptor, turnControls })).toBe(false);
    }
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v2", schemaVersion: 2, sourceEventId: "controls", sourceSeq: 1,
      sourceInstanceId: "runner", sourceKind: "runner", runId: "run", eventType: "session.capabilities.updated",
      priority: 0, emittedAt: "2026-09-28T12:00:00.000Z", payload: {
        sessionGoals: { availability: "unsupported", reason: "provider has no native goals", actions: [],
          autonomousUpdates: false, persistentAcrossResume: false, maxObjectiveChars: 4000,
          tokenBudgetControl: false, usageReporting: false },
        turnControls: descriptor.turnControls,
      },
    };
    expect(validatePrpEvent(event).ok).toBe(true);
    expect(validatePrpEvent({ ...event, payload: { ...event.payload, turnControls: { steering: "true" } } }).ok).toBe(false);
  });
  it("accepts ACPX sidecar and child process identities separately", () => {
    expect(validate({
      provider: "acpx",
      driver: "acpx_runtime",
      agent: "claude",
      model: "claude-sonnet-5",
      requestedModel: "claude-sonnet-5",
      executionKind: "local_process",
      providerVersion: "0.13.1",
      providerSessionId: "claude-session-1",
      processId: 41001,
      agentProcessId: 41002,
      acpProtocolVersion: 1,
      agentServerPackage: "@agentclientprotocol/claude-agent-acp",
      agentServerVersion: "0.85.1",
      agentRuntimePackage: null,
      agentRuntimeVersion: null,
      acpxRecordId: "acpx-record-1",
    })).toBe(true);
  });

});
