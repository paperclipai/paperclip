import { describe, expect, it } from "vitest";
import {
  assertValidAdapterLoginCapability,
  validateAdapterLoginCapability,
  type AdapterLoginCapability,
} from "./login-capability.js";

// A well-formed login capability. Each test starts from a clone of this value
// and then breaks one field, so each case checks exactly one rule.
function validCapability(): AdapterLoginCapability {
  return {
    panelMode: "displayed_code",
    sandboxTransport: "streamed_exec",
    timeoutPolicy: "caller_bounded",
    getCommand: () => "vendor login",
    parsePrompt: () => null,
  };
}

describe("assertValidAdapterLoginCapability", () => {
  it("accepts a well-formed capability with only the required fields", () => {
    expect(() => assertValidAdapterLoginCapability(validCapability(), "vendor")).not.toThrow();
  });

  it("accepts a well-formed capability with every optional member set", () => {
    const capability: AdapterLoginCapability = {
      panelMode: "submitted_browser_code",
      sandboxTransport: "pseudo_terminal",
      timeoutPolicy: "fixed",
      getCommand: () => "vendor setup-token",
      parsePrompt: () => null,
      captureCredential: () => null,
      onComplete: async () => {},
      completionClaim: "storedSessionId",
    };
    expect(() => assertValidAdapterLoginCapability(capability, "vendor")).not.toThrow();
  });

  it("rejects a non-object capability", () => {
    expect(() => assertValidAdapterLoginCapability(null, "vendor")).toThrow(/must be an object/);
    expect(() => assertValidAdapterLoginCapability("displayed_code", "vendor")).toThrow(
      /must be an object/,
    );
  });

  it("rejects an unknown panelMode", () => {
    const bad = { ...validCapability(), panelMode: "hidden_code" };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/panelMode/);
  });

  it("rejects an unknown sandboxTransport", () => {
    const bad = { ...validCapability(), sandboxTransport: "http" };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/sandboxTransport/);
  });

  it("rejects an unknown timeoutPolicy", () => {
    const bad = { ...validCapability(), timeoutPolicy: "unbounded" };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/timeoutPolicy/);
  });

  it("rejects a missing getCommand", () => {
    const bad = { ...validCapability(), getCommand: "vendor login" };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/getCommand/);
  });

  it("rejects a missing parsePrompt", () => {
    const bad = { ...validCapability(), parsePrompt: undefined };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/parsePrompt/);
  });

  it("rejects a non-function captureCredential", () => {
    const bad = { ...validCapability(), captureCredential: "token" };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/captureCredential/);
  });

  it("rejects a non-function onComplete", () => {
    const bad = { ...validCapability(), onComplete: true };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/onComplete/);
  });

  it("rejects an unknown completionClaim", () => {
    const bad = { ...validCapability(), completionClaim: "storedToken" };
    expect(() => assertValidAdapterLoginCapability(bad, "vendor")).toThrow(/completionClaim/);
  });

  it("names the adapter in the error text", () => {
    const bad = { ...validCapability(), panelMode: "hidden_code" };
    expect(() => assertValidAdapterLoginCapability(bad, "codex_local")).toThrow(/codex_local/);
  });
});

describe("validateAdapterLoginCapability", () => {
  it("accepts a module with no login capability", () => {
    expect(() => validateAdapterLoginCapability({ type: "vendor_local" })).not.toThrow();
  });

  it("accepts a module with a well-formed login capability", () => {
    expect(() =>
      validateAdapterLoginCapability({ type: "vendor_local", loginCapability: validCapability() }),
    ).not.toThrow();
  });

  it("rejects a module with a malformed login capability", () => {
    const bad = { ...validCapability(), panelMode: "hidden_code" };
    expect(() =>
      validateAdapterLoginCapability({ type: "vendor_local", loginCapability: bad }),
    ).toThrow(/vendor_local/);
  });
});
