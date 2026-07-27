import { describe, expect, it, vi } from "vitest";
import { createHostProcessRoutineExceptionCapabilityBroker } from "../services/routine-exception-capability-broker.js";

const DIGEST = "a".repeat(64);
const COMMAND = process.platform === "win32"
  ? "C:\\trusted\\routine-exception-broker.exe"
  : "/trusted/routine-exception-broker";

describe("host process routine exception capability broker", () => {
  it("fails closed when the immutable host broker is not configured", async () => {
    const broker = createHostProcessRoutineExceptionCapabilityBroker({ runtimeEnv: {} });

    await expect(broker.invoke("http.get:pol-runtime", {})).rejects.toThrow(
      "CAPABILITY_BROKER_UNAVAILABLE",
    );
  });

  it("pins the executable digest and forwards only allow-listed capabilities", async () => {
    const verifyExecutable = vi.fn(async () => undefined);
    const invokeProcess = vi.fn(async ({ capabilityId }) => ({
      capabilityId,
      ok: true,
    }));
    const broker = createHostProcessRoutineExceptionCapabilityBroker({
      runtimeEnv: {
        PAPERCLIP_ROUTINE_EXCEPTION_BROKER_EXECUTABLE: COMMAND,
        PAPERCLIP_ROUTINE_EXCEPTION_BROKER_SHA256: DIGEST,
      },
      verifyExecutable,
      invokeProcess,
    });

    await expect(broker.invoke("http.get:pol-runtime", { routeIds: ["status"] })).resolves.toEqual({
      capabilityId: "http.get:pol-runtime",
      ok: true,
    });
    await expect(broker.invoke("http.get:pol-runtime", { routeIds: ["readiness"] })).resolves.toEqual({
      capabilityId: "http.get:pol-runtime",
      ok: true,
    });
    await expect(broker.invoke("filesystem.write:anywhere", {})).rejects.toThrow("CAPABILITY_DENIED");
    expect(verifyExecutable).toHaveBeenCalledTimes(2);
    expect(invokeProcess).toHaveBeenNthCalledWith(1, expect.objectContaining({
      command: COMMAND,
      capabilityId: "http.get:pol-runtime",
      input: { routeIds: ["status"] },
    }));
  });

  it("does not invoke the broker when executable verification fails", async () => {
    const invokeProcess = vi.fn();
    const broker = createHostProcessRoutineExceptionCapabilityBroker({
      runtimeEnv: {
        PAPERCLIP_ROUTINE_EXCEPTION_BROKER_EXECUTABLE: COMMAND,
        PAPERCLIP_ROUTINE_EXCEPTION_BROKER_SHA256: DIGEST,
      },
      verifyExecutable: async () => {
        throw new Error("CAPABILITY_BROKER_DIGEST_MISMATCH");
      },
      invokeProcess,
    });

    await expect(broker.invoke("http.get:pol-runtime", {})).rejects.toThrow(
      "CAPABILITY_BROKER_DIGEST_MISMATCH",
    );
    expect(invokeProcess).not.toHaveBeenCalled();
  });
});
