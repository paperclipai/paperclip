import { describe, expect, it } from "vitest";
import { redactNativeFailureError } from "./native-failure-redaction.js";

const redact = (text: string) => text.replaceAll("agent-secret", "[redacted]");

describe("redactNativeFailureError", () => {
  it("keeps a timed-out transfer's own cause when its message cannot be reassigned", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    const timeout = signal.reason as Error;

    const redacted = redactNativeFailureError(timeout, redact);

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.name).toBe("TimeoutError");
    expect(redacted.message).toBe("The operation was aborted due to timeout");
  });

  it("redacts a read-only message and stack without throwing", () => {
    const failure = new DOMException("upload for agent-secret stalled", "AbortError");

    const redacted = redactNativeFailureError(failure, redact);

    expect(redacted.name).toBe("AbortError");
    expect(redacted.message).toBe("upload for [redacted] stalled");
    expect(redacted.stack ?? "").not.toContain("agent-secret");
  });

  it("redacts an ordinary error in place and keeps its type", () => {
    class TypedFailure extends Error {}
    const failure = new TypedFailure("provider rejected agent-secret");

    const redacted = redactNativeFailureError(failure, redact);

    expect(redacted).toBe(failure);
    expect(redacted).toBeInstanceOf(TypedFailure);
    expect(redacted.message).toBe("provider rejected [redacted]");
    expect(redacted.stack).not.toContain("agent-secret");
  });
});
