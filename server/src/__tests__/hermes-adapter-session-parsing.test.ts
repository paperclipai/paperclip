import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const adapterExecutePath = path.resolve(
  "node_modules/.pnpm/hermes-paperclip-adapter@0.2.0/node_modules/hermes-paperclip-adapter/dist/server/execute.js",
);

const fixedLegacySessionRegex = /(?:session[_ ]id\s*:\s*|session[_ ]saved[:\s]+)([a-zA-Z0-9_-]+)/i;

describe("hermes-paperclip-adapter session parsing patch", () => {
  it("does not treat Hermes 'session ID from a previous CLI run' hint text as session id 'from'", () => {
    const combined = "Session not found: from\nUse a session ID from a previous CLI run (hermes sessions list).\n";

    expect(combined.match(fixedLegacySessionRegex)?.[1]).toBeUndefined();
  });

  it("still accepts explicit legacy session_id output", () => {
    const combined = "\nsession_id: 20260509_142000_8af893\n";

    expect(combined.match(fixedLegacySessionRegex)?.[1]).toBe("20260509_142000_8af893");
  });

  it("keeps the installed Hermes adapter patched through pnpm patchedDependencies", () => {
    const source = fs.readFileSync(adapterExecutePath, "utf8");

    expect(source).toContain("(?:session[_ ]id\\s*:\\s*|session[_ ]saved[:\\s]+)([a-zA-Z0-9_-]+)");
    expect(source).not.toContain("session[_ ](?:id|saved)[:\\s]+([a-zA-Z0-9_-]+)");
    expect(source).toContain("function cfgSessionId(v)");
    expect(source).toContain("if (/^from$/i.test(value))");
    expect(source).toContain("if (/^\\d{8}_\\d{6}_$/.test(value))");
    expect(source).toContain("const prevSessionId = cfgSessionId(ctx.runtime?.sessionParams?.sessionId)");
  });
});
