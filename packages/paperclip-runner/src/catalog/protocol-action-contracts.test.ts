import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { PAPERCLIP_PROTOCOL_ACTIONS } from "../protocol-actions/index.js";

describe("canonical Paperclip protocol action contracts", () => {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });

  it.each(PAPERCLIP_PROTOCOL_ACTIONS.map((action) => [action.id, action] as const))(
    "%s has a schema-valid canonical example and every declared projection",
    (operationId, action) => {
      expect(action.canonical.operationId).toBe(operationId);
      expect(action.examples.call.operationId).toBe(operationId);
      expect(action.examples.success.operationId).toBe(operationId);
      expect(action.live !== null || action.scenario !== null).toBe(true);
      expect(Object.isFrozen(action)).toBe(true);
      expect(Object.isFrozen(action.canonical)).toBe(true);

      if (action.live !== null) {
        expect(action.live.descriptor.operationId).toBe(operationId);
        expect(
          ajv.validate(action.live.descriptor.inputSchema, action.examples.call.input),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        expect(
          ajv.validate(action.live.descriptor.outputSchema, action.examples.success.result),
          JSON.stringify(ajv.errors),
        ).toBe(true);
      }

      if (action.scenario !== null) {
        const scenarioProperties = action.scenario.descriptor.inputSchema.properties ?? {};
        const scenarioCall = "scenarioCall" in action.examples
          ? action.examples.scenarioCall
          : action.examples.call;
        const scenarioOutput = {
          schema: "paperclip.capability.tool-result.v1",
          ok: true,
          operationId,
          operationResultId: "example-result",
          value: action.examples.success.result,
          commandResult: null,
          authorization: {},
        };

        expect(action.scenario.descriptor.operationId).toBe(operationId);
        expect(scenarioCall.operationId).toBe(operationId);
        expect(
          Object.keys(scenarioCall.input).filter((key) => !(key in scenarioProperties)),
        ).toEqual([]);
        if (action.scenario.descriptor.idempotency === "required") {
          expect(action.examples).toHaveProperty("scenarioCall");
          expect(scenarioCall.idempotencyKey).toEqual(expect.any(String));
          expect(scenarioCall.idempotencyKey).not.toHaveLength(0);
        } else {
          expect(scenarioCall).not.toHaveProperty("idempotencyKey");
        }
        expect(
          ajv.validate(action.scenario.descriptor.inputSchema, scenarioCall.input),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        expect(
          ajv.validate(action.scenario.descriptor.outputSchema, scenarioOutput),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        expect(action.scenario.descriptor.mockCommandMapping).toBeDefined();
      }
    },
  );
});
