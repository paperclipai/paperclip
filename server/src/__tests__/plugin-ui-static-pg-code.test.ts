import { describe, expect, it } from "vitest";
import { errorChainHasPgCode } from "../routes/plugin-ui-static.js";

describe("errorChainHasPgCode (#7639)", () => {
  it("matches a code on the error itself (raw driver error)", () => {
    const raw = Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    expect(errorChainHasPgCode(raw, "22P02")).toBe(true);
  });

  it("matches a code on error.cause (DrizzleQueryError wrapping)", () => {
    const pg = Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    const wrapped = new Error("Failed query: select ...", { cause: pg });
    expect(errorChainHasPgCode(wrapped, "22P02")).toBe(true);
  });

  it("matches a code nested two causes deep", () => {
    const pg = Object.assign(new Error("boom"), { code: "22P02" });
    const mid = new Error("mid", { cause: pg });
    const outer = new Error("outer", { cause: mid });
    expect(errorChainHasPgCode(outer, "22P02")).toBe(true);
  });

  it("does not match a different code or non-error values", () => {
    const pg = Object.assign(new Error("fk"), { code: "23503" });
    expect(errorChainHasPgCode(new Error("x", { cause: pg }), "22P02")).toBe(false);
    expect(errorChainHasPgCode(new Error("plain"), "22P02")).toBe(false);
    expect(errorChainHasPgCode(null, "22P02")).toBe(false);
    expect(errorChainHasPgCode("22P02", "22P02")).toBe(false);
  });

  it("terminates on a self-referential cause chain", () => {
    const cyclic: Record<string, unknown> = { code: "XXXXX" };
    cyclic.cause = cyclic;
    expect(errorChainHasPgCode(cyclic, "22P02")).toBe(false);
  });
});
