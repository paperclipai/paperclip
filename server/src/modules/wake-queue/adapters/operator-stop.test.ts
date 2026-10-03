import { describe, expect, it } from "vitest";
import { isOperatorStoppedRunRow } from "./postgres.js";

describe("isOperatorStoppedRunRow", () => {
  it.each([
    [{ status: "cancelled", errorCode: "cancelled", resultJson: { cancelledByActorType: "user" } }, true],
    [{ status: "cancelled", errorCode: "cancelled", resultJson: { cancelledByActorType: "board" } }, true],
    [{ status: "cancelled", errorCode: "agent_paused", resultJson: null }, true],
    [{ status: "cancelled", errorCode: "operator_interrupted", resultJson: {} }, true],
    [{ status: "cancelled", errorCode: "cancelled", resultJson: { stopReason: "cancelled" } }, false],
    [{ status: "cancelled", errorCode: "issue_terminal_status", resultJson: null }, false],
    [{ status: "failed", errorCode: "agent_paused", resultJson: { cancelledByActorType: "user" } }, false],
  ])("classifies %j as %s", (row, expected) => {
    expect(isOperatorStoppedRunRow(row as never)).toBe(expected);
  });
});
