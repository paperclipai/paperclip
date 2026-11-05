import { describe, expect, it } from "vitest";
import { ClientAdmissionController } from "./socket-server.js";

function admission(overrides: Partial<ConstructorParameters<typeof ClientAdmissionController>[0]> = {}) {
  return new ClientAdmissionController({
    maxClients: 32,
    maxClientsPerUid: 8,
    serviceUid: 999,
    reservedServiceClients: 4,
    ...overrides,
  });
}

describe("ClientAdmissionController", () => {
  it("bounds one non-service peer by UID even when it opens 40 connections", () => {
    const controller = admission();
    const admitted = Array.from({ length: 40 }, () => controller.tryAcquire(1000));

    expect(admitted.filter(Boolean)).toHaveLength(8);
    expect(admitted.slice(8)).toEqual(Array(32).fill(false));
    expect(controller.tryAcquire(999)).toBe(true);
  });

  it("reserves global headroom for the Paperclip service UID", () => {
    const controller = admission({ maxClients: 6, maxClientsPerUid: 3, reservedServiceClients: 2 });

    expect(controller.tryAcquire(1000)).toBe(true);
    expect(controller.tryAcquire(1000)).toBe(true);
    expect(controller.tryAcquire(1001)).toBe(true);
    expect(controller.tryAcquire(1001)).toBe(true);
    expect(controller.tryAcquire(1002)).toBe(false);

    expect(controller.tryAcquire(999)).toBe(true);
    expect(controller.tryAcquire(999)).toBe(true);
    expect(controller.tryAcquire(999)).toBe(false);
  });

  it("returns capacity to the same UID when a socket finishes", () => {
    const controller = admission({ maxClients: 3, maxClientsPerUid: 1, reservedServiceClients: 1 });

    expect(controller.tryAcquire(1000)).toBe(true);
    expect(controller.tryAcquire(1000)).toBe(false);
    controller.release(1000);
    expect(controller.tryAcquire(1000)).toBe(true);
  });

  it("rejects quota configurations that would disable a bound or reservation", () => {
    expect(() => admission({ maxClientsPerUid: 0 })).toThrow(/maxClientsPerUid/);
    expect(() => admission({ maxClients: 8, maxClientsPerUid: 9 })).toThrow(/must not exceed/);
    expect(() => admission({ maxClients: 8, reservedServiceClients: 8 })).toThrow(/less than/);
  });
});
