import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";
import { runPhase0Tracer } from "./phase0-runner.js";

const expectedOutputUrl = new URL(
  "../../protocol/fixtures/phase-00-expected-output.json",
  import.meta.url,
);

describe("Phase 0 tracer", () => {
  it("prints a stable identity and result and stops the mock core", async () => {
    const mockCore = new MockControlPlaneAdapter();
    const expectedOutput = (await readFile(expectedOutputUrl, "utf8")).trimEnd();

    await expect(runPhase0Tracer(mockCore)).resolves.toBe(expectedOutput);
    expect(mockCore.snapshot().lifecycle).toBe("stopped");
  });
});
