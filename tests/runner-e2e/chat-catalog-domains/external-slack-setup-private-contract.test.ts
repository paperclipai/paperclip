import { expect, it } from "vitest";
import { validSlackSetupPrivate } from "./external-slack-setup-private-contract.js";
it("restricts private Slack credential entry to the exact owned existing-app draft", () => {
  const company = "11111111-1111-4111-8111-111111111111",
    input = {
      endpointId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "T123",
      signingSecret: "synthetic-private-signing",
    },
    url = `http://127.0.0.1:3100/ACORN/apps/chat/connect?provider=slack&purpose=chat&resume=${input.endpointId}&stage=credentials`;
  expect(validSlackSetupPrivate(company, input, url)).toBe(true);
  for (const wrong of [
    url.replace("slack", "discord"),
    url.replace(input.endpointId, company),
    url + "&reconnect=1",
    url.replace("credentials", "test"),
    url + "#other",
  ])
    expect(validSlackSetupPrivate(company, input, wrong)).toBe(false);
  expect(
    validSlackSetupPrivate(
      company,
      { ...input, signingSecret: "bad\nsecret" },
      url,
    ),
  ).toBe(false);
});
it("admits the exact real Reconnect route only in explicit repair mode", () => {
  const company = "11111111-1111-4111-8111-111111111111",
    input = {
      endpointId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "T123",
      signingSecret: "synthetic-private-signing",
    },
    url = `http://127.0.0.1:3100/ACORN/apps/chat/connect?provider=slack&purpose=chat&resume=${input.endpointId}&stage=credentials&reconnect=1`;
  expect(validSlackSetupPrivate(company, input, url, true)).toBe(true);
  expect(validSlackSetupPrivate(company, input, url)).toBe(false);
  expect(
    validSlackSetupPrivate(
      company,
      input,
      url.replace("reconnect=1", "reconnect=0"),
      true,
    ),
  ).toBe(false);
  expect(validSlackSetupPrivate(company, input, url + "&other=1", true)).toBe(
    false,
  );
});
