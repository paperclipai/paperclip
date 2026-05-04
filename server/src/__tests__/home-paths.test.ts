import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultAgentHomeDir } from "../home-paths.js";

const ORIGINAL_PAPERCLIP_HOME = process.env.PAPERCLIP_HOME;
const ORIGINAL_PAPERCLIP_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_HOME === undefined) {
    delete process.env.PAPERCLIP_HOME;
  } else {
    process.env.PAPERCLIP_HOME = ORIGINAL_PAPERCLIP_HOME;
  }
  if (ORIGINAL_PAPERCLIP_INSTANCE_ID === undefined) {
    delete process.env.PAPERCLIP_INSTANCE_ID;
  } else {
    process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_PAPERCLIP_INSTANCE_ID;
  }
});

describe("resolveDefaultAgentHomeDir", () => {
  it("resolves the canonical company agent home path", () => {
    process.env.PAPERCLIP_HOME = path.join("C:", "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    expect(resolveDefaultAgentHomeDir("company-1", "agent-1")).toBe(
      path.resolve("C:", "paperclip-home", "instances", "default", "companies", "company-1", "agents", "agent-1"),
    );
  });
});
