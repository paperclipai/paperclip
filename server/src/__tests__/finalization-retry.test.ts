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

  it("fails immediately on a 57P03 database shutdown error without retrying", async () => {
    const error = Object.assign(new Error("the database system is shutting down"), { code: "57P03" });
    const write = vi.fn().mockRejectedValue(error);

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toThrow(
      "the database system is shutting down",
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on a 57P01 admin shutdown error without retrying", async () => {
    const error = Object.assign(new Error("the database system is shutting down"), { code: "57P01" });
    const write = vi.fn().mockRejectedValue(error);

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toThrow(
      "the database system is shutting down",
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on a CONNECTION_CLOSED driver error without retrying", async () => {
    const error = Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" });
    const write = vi.fn().mockRejectedValue(error);

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toThrow("connection closed");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on an ECONNRESET socket error without retrying", async () => {
    const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const write = vi.fn().mockRejectedValue(error);

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toThrow("connection reset");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original terminal error object without wrapping", async () => {
    const terminalError = Object.assign(new Error("the database system is shutting down"), {
      code: "57P03",
    });
    const write = vi.fn().mockRejectedValue(terminalError);

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toBe(terminalError);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when a later attempt fails with a terminal error", async () => {
    const terminalError = Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" });
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("transient marker failure"))
      .mockRejectedValueOnce(terminalError)
      .mockRejectedValueOnce(new Error("should not be reached"));

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toBe(terminalError);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("retries an error with no code as a transient failure", async () => {
    const write = vi.fn().mockRejectedValue(new Error("unspecified failure"));

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toThrow("unspecified failure");
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("retries a non-object thrown value as a transient failure", async () => {
    const write = vi.fn().mockRejectedValue("string failure");

    await expect(persistFinalizationStepReliably(write, [0, 0])).rejects.toBe("string failure");
    expect(write).toHaveBeenCalledTimes(3);
  });
});
