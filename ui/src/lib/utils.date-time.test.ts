import { describe, expect, it } from "vitest";
import { formatDateTime, providerDisplayName } from "./utils";

describe("formatDateTime", () => {
  // Local construction avoids assuming the test runner's timezone.
  const timestamp = new Date(2026, 8, 7, 13, 2, 54);

  it("preserves minute precision for existing callers", () => {
    expect(formatDateTime(timestamp)).toBe("Sep 7, 2026, 1:02 PM");
  });

  it("distinguishes activity in the same minute when seconds are requested", () => {
    expect(formatDateTime(timestamp, { includeSeconds: true })).toBe(
      "Sep 7, 2026, 1:02:54 PM",
    );
    expect(
      formatDateTime(new Date(2026, 8, 7, 13, 2, 55), { includeSeconds: true }),
    ).toBe("Sep 7, 2026, 1:02:55 PM");
  });

  it("formats serialized server timestamps identically to Date values", () => {
    expect(
      formatDateTime(timestamp.toISOString(), { includeSeconds: true }),
    ).toBe(formatDateTime(timestamp, { includeSeconds: true }));
  });
});

describe("providerDisplayName", () => {
  it("maps ollama and ollama-cloud to friendly display names", () => {
    expect(providerDisplayName("ollama")).toBe("Ollama");
    expect(providerDisplayName("ollama-cloud")).toBe("Ollama Cloud");
    expect(providerDisplayName("ollama_cloud")).toBe("Ollama Cloud");
  });

  it("handles case insensitivity", () => {
    expect(providerDisplayName("OLLAMA")).toBe("Ollama");
    expect(providerDisplayName("Ollama-Cloud")).toBe("Ollama Cloud");
  });

  it("preserves existing providers", () => {
    expect(providerDisplayName("openai")).toBe("OpenAI");
    expect(providerDisplayName("anthropic")).toBe("Anthropic");
  });

  it("falls back to raw slug when unknown", () => {
    expect(providerDisplayName("custom-provider")).toBe("custom-provider");
  });
});
