import { expect, it } from "vitest";
import {
  validSlackHumanConnect,
  validSlackHumanReceipt,
} from "./external-slack-human-contract.js";
const input = {
  workspaceId: "T123",
  channelId: "C123",
  channelName: "owned-test-channel",
  senderUserId: "U123",
  command: "/owned-agent",
  session: {
    cookies: [
      {
        name: "d",
        value: "synthetic-private-session",
        domain: ".slack.com",
        path: "/",
        secure: true,
      },
    ],
    origins: [
      {
        origin: "https://app.slack.com",
        localStorage: [{ name: "session", value: "synthetic-private-storage" }],
      },
    ],
  },
};
it("admits only a bounded official Slack session and exact named workspace/person connect command", () => {
  expect(validSlackHumanConnect(input)).toBe(true);
  for (const mutate of [
    (x: typeof input) => {
      x.workspaceId = "other";
    },
    (x: typeof input) => {
      x.senderUserId = "UBOT\nother";
    },
    (x: typeof input) => {
      x.command = "/owned-agent delete";
    },
    (x: typeof input) => {
      x.session.cookies[0]!.domain = "slack.com.attacker.invalid";
    },
    (x: typeof input) => {
      x.session.cookies[0]!.secure = false;
    },
    (x: typeof input) => {
      x.session.origins[0]!.origin = "http://app.slack.com";
    },
    (x: typeof input) => {
      x.session.cookies = [];
    },
  ]) {
    const bad = structuredClone(input);
    mutate(bad);
    expect(validSlackHumanConnect(bad)).toBe(false);
  }
});
it("requires independently copied exact human ID and closed isolated browser receipt", () => {
  const r = {
    processIsolation: true,
    testRunnerAttached: false,
    tracingEnabled: false,
    videoEnabled: false,
    verifiedWorkspaceId: input.workspaceId,
    verifiedHumanId: input.senderUserId,
    commandSubmitted: true,
  };
  expect(validSlackHumanReceipt(r, input)).toBe(true);
  for (const wrong of [
    { ...r, verifiedHumanId: "another" },
    { ...r, verifiedWorkspaceId: "TOTHER" },
    { ...r, commandSubmitted: false },
    { ...r, testRunnerAttached: true },
    { ...r, tracingEnabled: true },
    { ...r, session: "unexpected" },
  ])
    expect(validSlackHumanReceipt(wrong, input)).toBe(false);
});

it("permits only exact app Request URL retry and distinct closed action evidence", () => {
  const retry = {
    ...input,
    operation: "retry-callback" as const,
    appId: "A123",
    callbackURL: "https://owned.invalid/api/chat-webhooks/owned/slack",
  };
  expect(validSlackHumanConnect(retry)).toBe(true);
  for (const bad of [
    { ...retry, appId: "other" },
    {
      ...retry,
      callbackURL: "http://owned.invalid/api/chat-webhooks/owned/slack",
    },
    {
      ...retry,
      callbackURL:
        "https://user:key@owned.invalid/api/chat-webhooks/owned/slack",
    },
    { ...retry, callbackURL: "https://owned.invalid/other" },
  ])
    expect(validSlackHumanConnect(bad)).toBe(false);
  const receipt = {
    processIsolation: true,
    testRunnerAttached: false,
    tracingEnabled: false,
    videoEnabled: false,
    verifiedWorkspaceId: input.workspaceId,
    verifiedHumanId: input.senderUserId,
    callbackRetryRequested: true,
  };
  expect(validSlackHumanReceipt(receipt, retry)).toBe(true);
  expect(validSlackHumanReceipt(receipt, input)).toBe(false);
  expect(
    validSlackHumanReceipt({ ...receipt, commandSubmitted: true }, retry),
  ).toBe(false);
});
