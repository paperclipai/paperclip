import { expect, it, vi } from "vitest";
import { withAdapterExecutionPhase } from "./execution-phase.js";

it("enters before a stalled await and releases only when that operation settles", async () => {
  const release = vi.fn();
  const enter = vi.fn(() => release);
  let resolve!: (value: number) => void;
  const operation = new Promise<number>((done) => { resolve = done; });
  const result = withAdapterExecutionPhase({ onExecutionPhase: enter }, "instruction_collection", () => operation);
  expect(enter).toHaveBeenCalledWith("instruction_collection");
  await Promise.resolve();
  expect(release).not.toHaveBeenCalled();
  resolve(7);
  await expect(result).resolves.toBe(7);
  expect(release).toHaveBeenCalledOnce();
});

it.each(["enter", "release"])("preserves values and errors when the %s diagnostic callback throws", async (where) => {
  const context = { onExecutionPhase: () => {
    if (where === "enter") throw new Error("diagnostic failure");
    return () => { throw new Error("diagnostic failure"); };
  } };
  await expect(withAdapterExecutionPhase(context, "workspace_restore", () => 3)).resolves.toBe(3);
  const failure = new Error("operation failure");
  await expect(withAdapterExecutionPhase(context, "workspace_restore", () => { throw failure; })).rejects.toBe(failure);
});
