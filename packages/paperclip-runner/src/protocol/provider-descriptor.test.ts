import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { providerDescriptorSchema } from "./generated/schema-bundle.js";

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(providerDescriptorSchema);

describe("provider runtime descriptor", () => {
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
      agentServerVersion: "0.70.0",
      agentRuntimePackage: null,
      agentRuntimeVersion: null,
      acpxRecordId: "acpx-record-1",
    })).toBe(true);
  });

});
