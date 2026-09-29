import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { questionSetSchema, requestSchema } from "./generated/schema-bundle.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addSchema(questionSetSchema);
const validate = ajv.compile(requestSchema);
const permission = {
  schema: "paperclip.runtime_request.v2",
  requestKind: "permission_approval",
  requestId: "permission-1",
  type: "permission",
  status: "pending",
  prompt: "Allow the proposed edit?",
  choices: [{ key: "accept", label: "Allow once" }, { key: "cancel", label: "Cancel" }],
  details: { toolCallId: "edit-1", kind: "edit" },
  origin: { adapter: "acpx-runtime-sidecar", provider: "acpx", method: "session/request_permission" },
  turnId: "turn-1",
  itemId: null,
};

describe("canonical ACP permission request schema", () => {
  it("admits the durable Rust projection and direct-driver item identity", () => {
    expect(validate(permission), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...permission, itemId: "permission-1" })).toBe(true);
  });

  it("rejects unknown, duplicate and unbounded approval choices", () => {
    for (const choices of [
      [],
      [{ key: "accept_always", label: "Allow forever" }],
      [{ key: "accept", label: "Once" }, { key: "accept", label: "Different label" }],
      [{ key: "accept", label: "x".repeat(501) }],
      [{ key: "accept", label: "Once", permissionPolicy: "full-auto" }],
    ]) expect(validate({ ...permission, choices })).toBe(false);
  });

  it("requires turn and origin binding and preserves the separate input contract", () => {
    const { turnId: _turn, ...withoutTurn } = permission;
    const { origin: _origin, ...withoutOrigin } = permission;
    expect(validate(withoutTurn)).toBe(false);
    expect(validate(withoutOrigin)).toBe(false);
    expect(validate({ ...permission, type: "input" })).toBe(false);
    expect(validate({ ...permission, requestKind: "runtime" })).toBe(false);
    expect(validate({ ...permission, resolverPolicy: "human_only" })).toBe(false);
  });
});
