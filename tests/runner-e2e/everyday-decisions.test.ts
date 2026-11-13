import { describe, expect, it } from "vitest";
import {
  pendingStoryDecision,
  type StoryInteraction,
} from "./everyday-decisions.js";
const tool: StoryInteraction = {
  id: "tool",
  kind: "request_confirmation",
  status: "pending",
  payload: {
    toolAction: { connectionId: "installed", actionRequestId: "action" },
  },
};
const connect: StoryInteraction = {
  id: "connect",
  kind: "connection_intent",
  status: "pending",
  payload: { serviceSlug: "notion" },
};
describe("the decision must match the user story before clicking", () => {
  it("accepts an approval bound to the installed fixture", () =>
    expect(
      pendingStoryDecision([tool], { kind: "tool", connectionId: "installed" }),
    ).toEqual(tool));
  it("rejects the historical Notion connection card in the tool-decline story", () =>
    expect(() =>
      pendingStoryDecision([connect], {
        kind: "tool",
        connectionId: "installed",
      }),
    ).toThrow(/connection_intent/));
  it("rejects an ordinary completion confirmation", () =>
    expect(() =>
      pendingStoryDecision([{ ...tool, payload: {} }], {
        kind: "tool",
        connectionId: "installed",
      }),
    ).toThrow(/tool action/));
  it("rejects an approval for a different connection", () =>
    expect(() =>
      pendingStoryDecision([tool], { kind: "tool", connectionId: "other" }),
    ).toThrow(/connection/));
  it("accepts Notion setup only in the new-connection story", () =>
    expect(
      pendingStoryDecision([connect], {
        kind: "connection",
        serviceSlug: "notion",
      }),
    ).toEqual(connect));
  it("rejects the wrong provider in a connection story", () =>
    expect(() =>
      pendingStoryDecision([connect], {
        kind: "connection",
        serviceSlug: "github",
      }),
    ).toThrow(/github/));
  it("rejects tool approval in the new-connection story", () =>
    expect(() =>
      pendingStoryDecision([tool], {
        kind: "connection",
        serviceSlug: "notion",
      }),
    ).toThrow(/connection_intent/));
  it("rejects duplicate pending requests rather than clicking an arbitrary card", () =>
    expect(() =>
      pendingStoryDecision([tool, { ...tool, id: "duplicate" }], {
        kind: "tool",
        connectionId: "installed",
      }),
    ).toThrow(/exactly one/));
  it("ignores resolved historical interactions", () =>
    expect(
      pendingStoryDecision([{ ...connect, status: "rejected" }, tool], {
        kind: "tool",
        connectionId: "installed",
      }),
    ).toEqual(tool));
});
