import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { toolInputError } from "./tool-input-error.js";
import { createCaseAction } from "../protocol-actions/case-data.js";

it("leaves ordinary validation errors unchanged and excludes guidance from unrelated scopes", () => {
  const validate = new Ajv2020({ allErrors: true }).compile({ type: "object", required: ["id", "child"], properties: {
    id: { type: "string", description: "Root ID guidance" },
    child: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Nested guidance" } } },
  } });
  validate({ id: 9, child: {} });
  expect(toolInputError(validate)).toBe("Invalid tool input: /id must be string; /child must have required property 'id'");
  expect(toolInputError(undefined)).toBe("Invalid tool input.");
});

it("bounds and deduplicates direct missing-property descriptions", () => {
  const properties = Object.fromEntries(["a", "b", "c", "d", "e"].map(key => [key, { type: "string", description: key === "b" ? "a".repeat(1100) : key.repeat(1100) }]));
  const validate = new Ajv2020({ allErrors: true }).compile({ type: "object", required: Object.keys(properties), properties });
  validate({});
  const result = toolInputError(validate);
  expect(result).toContain("a".repeat(1000));
  expect(result).toContain("c".repeat(1000));
  expect(result).toContain("d".repeat(1000));
  expect(result).not.toContain("e".repeat(1000));
  expect(result).not.toContain("a".repeat(1001));
});

it("names the missing create_case fields, what the call included, and a short example", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(createCaseAction.live.descriptor.inputSchema);
  const input = { workflow_document_text: "Investigate, then verify." };
  expect(validate(input)).toBe(false);
  const result = toolInputError(validate, input);
  expect(result).toContain("missing required fields: idempotencyKey, caseType, title, kickoff.");
  expect(result).toContain("This call included only: workflow_document_text.");
  expect(result).toContain('Missing fields example: {"idempotencyKey":"<idempotencyKey>","caseType":"<caseType>","title":"<title>","kickoff":{"toAgentId":"<toAgentId>","phase":"<phase>","instructions":"<instructions>"}}');
  expect(result).not.toContain("must have required property");
});

it("keeps other validation errors after the missing fields", () => {
  const validate = new Ajv2020({ allErrors: true }).compile({ type: "object", required: ["id", "count"], properties: {
    id: { type: "string" }, count: { type: "integer" }, child: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  } });
  const input = { child: {} };
  validate(input);
  expect(toolInputError(validate, input)).toBe(
    'Invalid tool input: missing required fields: id, count. This call included only: child. Send every required field together in one call, alongside the fields you already sent. Missing fields example: {"id":"<id>","count":0} Also: /child must have required property \'id\'',
  );
});
