import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../../redaction.js";
import { redactPersistedRunWritePatch } from "../run-persisted-output-redaction.js";

describe("redactPersistedRunWritePatch", () => {
  it("redacts resultJson string leaves and excerpts with static and registered values", () => {
    const canary = "synthetic-canary-token-value";
    const patch = redactPersistedRunWritePatch(
      {
        resultJson: {
          stdout: `PAPERCLIP_API_KEY=${canary}`,
          nested: { stderr: canary },
        },
        stdoutExcerpt: `export DATABASE_URL=postgres://u:${canary}@h`,
        stderrExcerpt: canary,
        error: `failed: ${canary}`,
      },
      [canary],
    );

    const serialized = JSON.stringify(patch);
    expect(serialized).not.toContain(canary);
    expect(patch.stdoutExcerpt).toContain(REDACTED_EVENT_VALUE);
    expect(patch.stderrExcerpt).toBe(REDACTED_EVENT_VALUE);
    expect(patch.error).toContain(REDACTED_EVENT_VALUE);
  });
});
