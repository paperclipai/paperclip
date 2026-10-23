import { describe, expect, it } from "vitest";
import { providerDisplayName } from "./utils";

describe("providerDisplayName", () => {
  it("names Ollama providers", () => {
    expect(providerDisplayName("ollama")).toBe("Ollama");
    expect(providerDisplayName("ollama-cloud")).toBe("Ollama Cloud");
    expect(providerDisplayName("Ollama-Cloud")).toBe("Ollama Cloud");
  });

  it("keeps an unknown slug unchanged", () => {
    expect(providerDisplayName("my-gateway")).toBe("my-gateway");
  });
});
