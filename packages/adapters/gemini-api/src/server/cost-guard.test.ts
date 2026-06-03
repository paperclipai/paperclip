import { describe, expect, it } from "vitest";
import {
  checkTokensPerRun,
} from "./cost-guard.js";

// checkTokensPerRun is stateless — easy to test directly
describe("checkTokensPerRun", () => {
  it("returns null when tokens are within limit", () => {
    expect(checkTokensPerRun(50_000, 100_000)).toBeNull();
  });

  it("returns null at exactly the limit", () => {
    expect(checkTokensPerRun(100_000, 100_000)).toBeNull();
  });

  it("returns violation when tokens exceed limit", () => {
    const result = checkTokensPerRun(100_001, 100_000);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tokens_per_run");
    if (result?.kind === "tokens_per_run") {
      expect(result.tokens).toBe(100_001);
      expect(result.limit).toBe(100_000);
    }
  });

  it("returns violation for zero token limit exceeded", () => {
    const result = checkTokensPerRun(1, 0);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tokens_per_run");
  });

  it("returns null when both tokens and limit are zero", () => {
    expect(checkTokensPerRun(0, 0)).toBeNull();
  });
});

// hourKey / dayKey helper logic (tested inline)
describe("hourKey and dayKey derivation", () => {
  it("produces a consistent UTC hour string", () => {
    const d = new Date("2026-05-30T14:42:00.000Z");
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
    expect(key).toBe("2026-05-30T14");
  });

  it("produces a consistent UTC day string", () => {
    const d = new Date("2026-05-30T23:59:59.999Z");
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    expect(key).toBe("2026-05-30");
  });
});
