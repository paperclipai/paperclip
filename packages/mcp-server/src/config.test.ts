import { describe, expect, it } from "vitest";
import { readConfigFromEnv } from "./config.js";

const REQUIRED = {
  PAPERCLIP_API_URL: "http://localhost:3100",
  PAPERCLIP_API_KEY: "key",
};

const VALID_RUN_ID = "0190f8e2-7b6c-7c1f-9e7f-3d3f4a2b1c8a";

describe("readConfigFromEnv runId validation", () => {
  it("accepts a canonical UUID", () => {
    const cfg = readConfigFromEnv({ ...REQUIRED, PAPERCLIP_RUN_ID: VALID_RUN_ID });
    expect(cfg.runId).toBe(VALID_RUN_ID);
  });

  it("normalizes uppercase to lowercase", () => {
    const cfg = readConfigFromEnv({ ...REQUIRED, PAPERCLIP_RUN_ID: VALID_RUN_ID.toUpperCase() });
    expect(cfg.runId).toBe(VALID_RUN_ID);
  });

  it("treats an absent env var as null (no runId)", () => {
    const cfg = readConfigFromEnv(REQUIRED);
    expect(cfg.runId).toBeNull();
  });

  it("treats an empty env var as null (no runId)", () => {
    const cfg = readConfigFromEnv({ ...REQUIRED, PAPERCLIP_RUN_ID: "" });
    expect(cfg.runId).toBeNull();
  });

  it("throws on invalid PAPERCLIP_RUN_ID (smoke-script label pattern)", () => {
    expect(() =>
      readConfigFromEnv({ ...REQUIRED, PAPERCLIP_RUN_ID: "smoke-run-1717000000" }),
    ).toThrow(/Invalid PAPERCLIP_RUN_ID.*smoke-run-1717000000/);
  });

  it("throws on invalid PAPERCLIP_RUN_ID (manual session label pattern)", () => {
    expect(() =>
      readConfigFromEnv({ ...REQUIRED, PAPERCLIP_RUN_ID: "manual-smilerite-20260527T141106Z" }),
    ).toThrow(/Invalid PAPERCLIP_RUN_ID/);
  });
});
