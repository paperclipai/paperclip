import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  capabilitySemanticToolDescriptor,
  paperclipSemanticAction,
} from "@paperclipai/paperclip-runner";
import { PROJECT_ICON_NAMES } from "@paperclipai/shared";

// Cross-package parity belongs at the App boundary: the standalone runner
// must not import the App's shared package, even from its own tests.
describe("runner project icon contract", () => {
  it("advertises only icons accepted by the project API on both tool surfaces", () => {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    for (const schema of [
      capabilitySemanticToolDescriptor("create_project")!.inputSchema,
      paperclipSemanticAction("create_project")!.inputSchema,
    ]) {
      const validate = ajv.compile(schema);
      const input = { name: "Onboarding", idempotencyKey: "onboarding" };
      expect(schema).toMatchObject({ properties: { icon: { enum: [...PROJECT_ICON_NAMES, null] } } });
      for (const icon of [...PROJECT_ICON_NAMES, null]) expect(validate({ ...input, icon }), String(icon)).toBe(true);
      expect(validate({ ...input, icon: "users" })).toBe(false);
    }
  });
});
