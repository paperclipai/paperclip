import { expect, it } from "vitest";
import {
  validSlackIdentityInput,
  matchingSlackIdentityPreview,
} from "./external-slack-identity-contract.js";
const companyId = "11111111-1111-4111-8111-111111111111",
  input = {
    endpointId: "22222222-2222-4222-8222-222222222222",
    principalId: "33333333-3333-4333-8333-333333333333",
    userId: "fixture-person",
    externalDetail: "@fixture.human",
    externalLabel: "Fixture Human",
  },
  url = `http://127.0.0.1:3100/ACORN/apps/chat/${input.endpointId}/access`;
it("admits only the finite same-person same-endpoint Access UI", () => {
  expect(validSlackIdentityInput(companyId, input, url)).toBe(true);
  for (const bad of [
    url + "?next=/admin",
    url.replace("/access", "/other"),
    url + "#other",
    url.replace(input.endpointId, companyId),
  ])
    expect(validSlackIdentityInput(companyId, input, bad)).toBe(false);
  expect(
    validSlackIdentityInput(companyId, { ...input, principalId: "wrong" }, url),
  ).toBe(false);
  expect(
    validSlackIdentityInput(
      companyId,
      { ...input, externalDetail: "@someone\nelse" },
      url,
    ),
  ).toBe(false);
});
it("requires actual preview company, endpoint, Slack provider and independently resolved external identity", () => {
  const value = {
    companyId,
    endpointId: input.endpointId,
    provider: "slack",
    externalDetail: input.externalDetail,
    canConfirm: true,
  };
  expect(matchingSlackIdentityPreview(value, companyId, input)).toBe(true);
  for (const wrong of [
    { ...value, companyId: "other" },
    { ...value, endpointId: "other" },
    { ...value, provider: "discord" },
    { ...value, externalDetail: "@same.display.name" },
    { ...value, canConfirm: false },
  ])
    expect(matchingSlackIdentityPreview(wrong, companyId, input)).toBe(false);
});

import { validSlackWizardIdentityInput } from "./external-slack-identity-contract.js";
it("restricts normal wizard continuation to the same real identity and exact saved Slack setup", () => {
  const setup = `http://127.0.0.1:3100/ACORN/apps/chat/connect?provider=slack&purpose=chat&resume=${input.endpointId}`;
  expect(validSlackWizardIdentityInput(companyId, input, setup)).toBe(true);
  for (const wrong of [
    setup + "&stage=test",
    setup.replace(input.endpointId, companyId),
    setup.replace("slack", "discord"),
    setup + "#test",
  ])
    expect(validSlackWizardIdentityInput(companyId, input, wrong)).toBe(false);
});
