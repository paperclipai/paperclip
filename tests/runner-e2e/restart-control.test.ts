import { expect, it } from "vitest";
import { isolatedRestartSignal, parseIsolatedRestartRequest } from "./restart-control.js";

it("accepts owned hard restart without accepting a caller-selected process", () => {
  expect(parseIsolatedRestartRequest({ requestId: "round-2", mode: "hard" })).toEqual({ requestId: "round-2", mode: "hard" });
  expect(isolatedRestartSignal("hard")).toBe("SIGKILL");
  expect(parseIsolatedRestartRequest({ requestId: "old" })).toEqual({ requestId: "old", mode: "graceful" });
  for (const extra of [{ pid: 1 }, { signal: "SIGKILL" }, { mode: "SIGKILL" }, { command: "kill" }]) {
    expect(parseIsolatedRestartRequest({ requestId: "round", ...extra })).toBeNull();
  }
});
