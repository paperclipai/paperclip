import { expect, it } from "vitest";
import { runAdapterType } from "./run-adapter";

it("uses the immutable execution claim for a mixed-provider run", () => {
  expect(runAdapterType({ runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", configuredAdapterType: "claude_local" } } }, "claude_local")).toBe("codex_local");
});

it.each([null, {}, { adapterDispatch: null }, { adapterDispatch: [] }, { adapterDispatch: { adapterType: "" } }, { adapterDispatch: { adapterType: "  " } }, { adapterDispatch: { adapterType: 42 } }])("falls back for old or pending runs without a valid execution claim: %j", runnerProfileJson => {
  expect(runAdapterType({ runnerProfileJson }, "claude_local")).toBe("claude_local");
});
