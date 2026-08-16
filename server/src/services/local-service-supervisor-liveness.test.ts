import { afterEach, describe, expect, it, vi } from "vitest";
import { isPidAlive, isProcessGroupAlive } from "./local-service-supervisor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local service liveness probes", () => {
  it("treats EPERM as proof that a pid exists", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(isPidAlive(4242)).toBe(true);
  });

  it("treats EPERM as proof that a process group exists", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(isProcessGroupAlive(4242)).toBe(true);
  });
});
