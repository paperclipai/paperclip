import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

/**
 * Phase 1 calls the product concept a worktree, but the full HTTP/OpenAPI wire
 * contract intentionally retains its legacy workspace spellings.
 */
describe("worktree terminology OpenAPI contract freeze", () => {
  it("keeps the complete serialized OpenAPI document byte-identical", () => {
    const bytes = JSON.stringify(buildOpenApiSpec());
    const digest = createHash("sha256").update(bytes).digest("hex");

    expect(bytes).toHaveLength(864_509);
    expect(digest).toBe("8bc8e0272bf4d7f98c3e44fd840abdb6ed4f19a95e4d5cdd6de4202aef19f84a");
  });
});
