import { describe, it, expect } from "vitest";
import {
  runtimePrivateRequirements,
  validateRuntimePrivateRequirement,
  runtimePrivateReferenceNames,
} from "../chat-runtime-private-requirements.js";
import {
  selectedRuntimeInputs,
  runtimePrivateSpec,
} from "./runtime-private.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const id = "assistant-connections.connect-external-assistant" as const;
describe("exact named ChatGPT operator private requirement", () => {
  it("declares only selected operator/account authorization metadata and no API credential surrogate", () => {
    const spec = runtimePrivateRequirements[id];
    expect(spec).toEqual({
      provider: "chatgpt",
      fields: ["operatorRef", "chatgptAuthorizationRef", "operatorMode"],
      credentials: [],
    });
    expect(
      validateRuntimePrivateRequirement(
        id,
        spec.provider,
        spec.fields,
        spec.credentials,
      ),
    ).toBe(true);
    expect(runtimePrivateReferenceNames("chatgpt")).toEqual([]);
    expect(runtimePrivateSpec(id).requiredCredentials).toEqual([]);
  });
  it("rejects unrelated cases, extra implicit credentials and undeclared session seams", () => {
    const spec = runtimePrivateRequirements[id];
    for (const args of [
      ["assistant-connections.use-scoped-client", spec.fields, []],
      [id, [...spec.fields, "sessionJson"], []],
      [id, spec.fields, ["OPENAI_API_KEY"]],
    ] as const)
      expect(() =>
        validateRuntimePrivateRequirement(args[0], "chatgpt", args[1], args[2]),
      ).toThrow();
  });
  it("requires the exact selected disposable provider config; never an ambient or other-provider authorization", () => {
    const configuration = {
      schemaVersion: 1,
      providers: {
        chatgpt: {
          disposable: true,
          resourceIds: ["authorized-synthetic-chatgpt"],
          prerequisites: {
            operatorRef: "qa-operator",
            chatgptAuthorizationRef: "authorized-synthetic-chatgpt",
            operatorMode: "interactive-private-ui",
          },
        },
      },
    };
    const context = {
      scenario: { id },
      input: {
        privateInputs: {
          configuration: () => configuration,
          credentials: {},
          read: () => undefined,
        },
      },
    } as unknown as ChatCatalogContext;
    expect(selectedRuntimeInputs(context, id).values.operatorRef).toBe(
      "qa-operator",
    );
    for (const variant of [
      undefined,
      { ...configuration, providers: {} },
      {
        ...configuration,
        providers: {
          chatgpt: { ...configuration.providers.chatgpt, disposable: false },
        },
      },
    ])
      expect(() =>
        selectedRuntimeInputs(
          {
            ...context,
            input: {
              ...context.input,
              privateInputs: {
                ...context.input.privateInputs!,
                configuration: () => variant,
              },
            },
          },
          id,
        ),
      ).toThrow();
    expect(() =>
      selectedRuntimeInputs(
        {
          ...context,
          scenario: {
            ...context.scenario,
            id: "assistant-connections.decline-consent",
          },
        },
        id,
      ),
    ).toThrow();
  });
});
