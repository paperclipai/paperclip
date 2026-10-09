import { describe, expect, it, vi } from "vitest";
import { deliverAcpxResponse, requireAcpxResponseDelivery } from "./response-delivery.js";

describe("ACP interaction response delivery", () => {
  it("does not acknowledge callback settlement before the provider pipe write", async () => {
    const written = Promise.withResolvers<void>();
    const settle = vi.fn();
    let acknowledged = false;
    const pending = deliverAcpxResponse(requireAcpxResponseDelivery({ responseDelivery: written.promise }), settle)
      .then(value => { acknowledged = true; return value; });
    expect(settle).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    written.resolve();
    await expect(pending).resolves.toEqual({ resolved: true });
  });

  it.each(["cancelled", "disconnected", "write failed"])("does not report delivery when the response is %s", async reason => {
    const written = Promise.withResolvers<void>();
    const pending = deliverAcpxResponse(written.promise, () => {});
    const failed = expect(pending).rejects.toThrow(reason);
    written.reject(new Error(reason));
    await failed;
  });

  it("requires a transport-owned receipt before presenting an interaction", () => {
    expect(() => requireAcpxResponseDelivery({})).toThrow("no bound provider response");
  });
});
