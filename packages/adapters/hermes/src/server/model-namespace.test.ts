import { expect, test } from "vitest";

import {
  findModelNamespaceHint,
  modelNamespaceOf,
  validateHermesModelProviderAlignment,
} from "./model-namespace.js";

test("modelNamespaceOf returns the namespace of a namespaced model id only", () => {
  expect(modelNamespaceOf("openrouter/gpt-4.1-mini")).toBe("openrouter");
  expect(modelNamespaceOf("openrouter/thinkingmachines/inkling-small:free")).toBe("openrouter");
  expect(modelNamespaceOf("gpt-4.1-mini")).toBeNull();
});

test("findModelNamespaceHint resolves the exclusive provider of a known namespace", () => {
  expect(findModelNamespaceHint("openrouter/gpt-4.1-mini")?.providers).toEqual(["openrouter"]);
  expect(findModelNamespaceHint("anthropic/claude-3.5-sonnet")).toBeNull();
});

test("validateHermesModelProviderAlignment rejects a model id whose namespace disagrees with the provider", () => {
  const result = validateHermesModelProviderAlignment({
    model: "openrouter/gpt-4.1-mini",
    provider: "openai-codex",
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toContain("openrouter");
  expect(result.reason).toContain("openai-codex");
});

test("validateHermesModelProviderAlignment rejects a model id whose namespace disagrees with the base URL", () => {
  const result = validateHermesModelProviderAlignment({
    model: "openrouter/gpt-4.1-mini",
    provider: "openrouter",
    baseUrl: "https://api.minimax.io/v1",
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toContain("base URL");
  expect(result.reason).toContain("api.minimax.io");
});

test("validateHermesModelProviderAlignment accepts an agreeing provider and base URL", () => {
  expect(validateHermesModelProviderAlignment({
    model: "openrouter/gpt-4.1-mini",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  }).ok).toBe(true);
  expect(validateHermesModelProviderAlignment({
    model: "openrouter/thinkingmachines/inkling-small:free",
    provider: "auto",
  }).ok).toBe(true);
  expect(validateHermesModelProviderAlignment({
    model: "claude-sonnet-4",
    provider: "anthropic",
  }).ok).toBe(true);
  expect(validateHermesModelProviderAlignment({}).ok).toBe(true);
});
