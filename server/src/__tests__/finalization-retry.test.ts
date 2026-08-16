import { describe, expect, it, vi } from "vitest";
import { persistFinalizationStepReliably } from "../services/finalization-retry.ts";

describe("finalization persistence retry", () => {
  it("retries a transient marker failure until the durable write succeeds", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("transient marker failure one"))
      .mockRejectedValueOnce(new Error("transient marker failure two"))
      .mockResolvedValueOnce("durable");

    await expect(persistFinalizationStepReliably(write, [0, 0])).resolves.toBe("durable");
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("fails closed after the bounded retry budget is exhausted", async () => {
    const write = vi.fn().mockRejectedValue(new Error("persistent marker failure"));

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toThrow(
      "persistent marker failure",
    );
    expect(write).toHaveBeenCalledTimes(3);
  });
});
