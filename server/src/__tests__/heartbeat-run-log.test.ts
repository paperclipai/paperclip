import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("redacts tokenized git remotes before persisting run-log chunks", () => {
    // `git push -u` retained `https://<token>@github.com/...` in the shell
    // transcript. Known `ghp_`/`ghu_` prefixes were already scrubbed; opaque
    // userinfo, fine-grained PATs, and Authorization token/Basic were not.
    const opaque = "opaquecompanytokenvalue1234567890abcd";
    const fineGrained = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";
    const basic = Buffer.from(`git:${opaque}`).toString("base64");
    const chunk = [
      `remote: https://${opaque}@github.com/paperclipai/paperclip.git`,
      `fatal: unable to access 'https://x-access-token:${opaque}@github.com/GULP-GAMES/SayaSync.git/': The requested URL returned error: 403`,
      `https://${fineGrained}@github.com/org/repo.git`,
      `Authorization: token ${opaque}`,
      `Authorization: Basic ${basic}`,
      `To https://github.com/org/repo.git`,
      `git@github.com:org/repo.git`,
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(opaque);
    expect(compacted).not.toContain(fineGrained);
    expect(compacted).not.toContain(basic);
    expect(compacted).toContain("https://***REDACTED***@github.com/paperclipai/paperclip.git");
    expect(compacted).toContain("https://github.com/org/repo.git");
    expect(compacted).toContain("git@github.com:org/repo.git");
  });
});
