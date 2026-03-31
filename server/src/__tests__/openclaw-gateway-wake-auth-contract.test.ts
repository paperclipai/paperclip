import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("openclaw-gateway wake auth contract", () => {
  it("describes exec-scoped runtime auth instead of model-visible env auth", () => {
    const filePath = path.resolve(
      process.cwd(),
      "packages/adapters/openclaw-gateway/src/server/execute.ts",
    );
    const text = fs.readFileSync(filePath, "utf8");

    expect(text).toContain(
      'Runtime auth is provided structurally in the OpenClaw request and is guaranteed on exec/tool command paths, not as a model-visible environment variable.',
    );
    expect(text).toContain(
      'For every Paperclip API call in this workflow, use exec/curl (or an equivalent command tool path) so PAPERCLIP_API_KEY / PAPERCLIP_AUTH_HEADER are available from the tool environment.',
    );
    expect(text).not.toContain(
      'When runtime auth is present, it is installed into the runtime environment as PAPERCLIP_API_KEY and PAPERCLIP_AUTH_HEADER.',
    );
    expect(text).toContain('Use exec/curl to GET /api/agents/me.');
    expect(text).toContain('Use exec/curl to POST /api/issues/{issueId}/checkout');
  });
});
