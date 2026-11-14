import { afterEach, describe, expect, it } from "vitest";
import { createUuid, installInsecureRandomUuid } from "./uuid";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createUuid", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis.crypto, "randomUUID", original);
    else Reflect.deleteProperty(globalThis.crypto, "randomUUID");
  });

  function hideRandomUuid() {
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  }

  it("returns an RFC 4122 UUID when randomUUID is missing", () => {
    hideRandomUuid();
    expect(createUuid()).toMatch(UUID);
  });

  it("installs randomUUID for plain HTTP call sites", () => {
    hideRandomUuid();
    installInsecureRandomUuid();
    expect(globalThis.crypto.randomUUID()).toMatch(UUID);
  });
});
