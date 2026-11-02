import { describe, expect, it } from "vitest";
import {
  chatSetupErrorFallback,
  sanitizedSetupErrorMessage,
} from "./chat-setup-error";

describe("sanitizedSetupErrorMessage", () => {
  it("redacts raw, JSON-escaped, and URI-encoded submitted credentials", () => {
    const secret = 'token / "line\nnext"';
    const jsonEscapedSecret = JSON.stringify(secret).slice(1, -1);
    const uriEncodedSecret = encodeURIComponent(secret);

    expect(
      sanitizedSetupErrorMessage(
        new Error(
          `Provider rejected ${secret}; payload=${jsonEscapedSecret}; query=${uriEncodedSecret}`,
        ),
        { botToken: secret },
      ),
    ).toBe(
      "Provider rejected [redacted]; payload=[redacted]; query=[redacted]",
    );
  });

  it("uses actionable fallback copy when no error message is available", () => {
    expect(sanitizedSetupErrorMessage(undefined, undefined)).toBe(
      chatSetupErrorFallback,
    );
    expect(sanitizedSetupErrorMessage(new Error("   "), {})).toBe(
      chatSetupErrorFallback,
    );
  });

  it("redacts malformed UTF-16 credentials without throwing", () => {
    const malformedSecret = "\ud800";
    const escapedSecret = JSON.stringify(malformedSecret).slice(1, -1);

    expect(
      sanitizedSetupErrorMessage(
        new Error(`Provider rejected ${malformedSecret} (${escapedSecret})`),
        { botToken: malformedSecret },
      ),
    ).toBe("Provider rejected [redacted] ([redacted])");
  });
});
