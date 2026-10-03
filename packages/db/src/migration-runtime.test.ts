import { describe, expect, it } from "vitest";
import { formatEmbeddedPostgresPortUnavailableError } from "./migration-runtime.js";

describe("formatEmbeddedPostgresPortUnavailableError", () => {
  it("includes the scanned range and WSL2 reserved-port guidance", () => {
    const message = formatEmbeddedPostgresPortUnavailableError(54329, 20);

    expect(message).toContain("54329 to 54348");
    expect(message).toContain("Windows/WSL2");
    expect(message).toContain("netsh interface ipv4 show excludedportrange protocol=tcp");
    expect(message).toContain("database.embeddedPostgresPort");
  });
});
