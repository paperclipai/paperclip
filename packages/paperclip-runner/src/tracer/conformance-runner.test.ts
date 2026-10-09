import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";
import { runConformanceTracer } from "./conformance-runner.js";

const expectedOutputUrl = new URL(
  "../../protocol/fixtures/conformance-expected-output.json",
  import.meta.url,
);

describe("Conformance tracer", () => {
  it("prints a stable identity and result and stops the mock core", async () => {
    const mockCore = new MockControlPlaneAdapter();
    const expectedOutput = (await readFile(expectedOutputUrl, "utf8")).trimEnd();

    await expect(runConformanceTracer(mockCore)).resolves.toBe(expectedOutput);
    expect(mockCore.snapshot().lifecycle).toBe("stopped");
  });
});
