import { expect, it } from "vitest";
import {
  validGrokRoutinePrivateInput,
  matchesConfiguredGrokRoutine,
} from "./external-grok-private-contract.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const input = {
  agentId: "22222222-2222-4222-8222-222222222222",
  bindingId: "33333333-3333-4333-8333-333333333333",
  expectedRevision: 0,
  botName: "Owned Grok Bot",
  webhookUrl: "https://fixture.invalid/owned-webhook",
};
const setupURL = `http://127.0.0.1:3100/ACORN/agents/${input.agentId}/runtime`;

it("admits only the exact saved-agent protected routine form", () => {
  expect(validGrokRoutinePrivateInput(companyId, input, setupURL)).toBe(true);
  for (const bad of [
    { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: 0.5 },
    { ...input, agentId: "wrong-agent" },
    { ...input, botName: "Bot\r\nInjected" },
    { ...input, webhookUrl: "http://fixture.invalid/webhook" },
    { ...input, webhookUrl: "https://user:key@fixture.invalid/webhook" },
    { ...input, webhookUrl: "https://fixture.invalid/webhook#key" },
  ])
    expect(validGrokRoutinePrivateInput(companyId, bad, setupURL)).toBe(false);
  expect(
    validGrokRoutinePrivateInput(companyId, input, setupURL + "/other"),
  ).toBe(false);
  expect(validGrokRoutinePrivateInput(undefined, input, setupURL)).toBe(false);
});

it("requires the exact persisted binding/revision and configuration without a false verification claim", () => {
  const saved = {
    bindingId: input.bindingId,
    revision: 1,
    configured: true,
    verified: false,
  };
  expect(matchesConfiguredGrokRoutine(saved, input.bindingId, 0)).toBe(true);
  for (const bad of [
    { ...saved, bindingId: companyId },
    { ...saved, revision: 0 },
    { ...saved, configured: false },
    { ...saved, verified: true },
    undefined,
  ])
    expect(matchesConfiguredGrokRoutine(bad, input.bindingId, 0)).toBe(false);
});
